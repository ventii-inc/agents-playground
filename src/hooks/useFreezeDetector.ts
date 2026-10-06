"use client";

import {
  DetectorInput,
  FreezeDetector,
  FreezeIncidentDraft,
  readInboundReceiverStats,
} from "@/lib/freezeDetector";
import type { RemoteTrack, Room } from "livekit-client";
import { useCallback, useEffect, useRef, useState } from "react";

export type FreezeReportStatus =
  | { state: "idle" }
  | { state: "saving" }
  | { state: "saved"; id: string }
  | { state: "error"; message: string };

type StoredIncident = {
  report: FreezeIncidentDraft & { room: string; browser: "chrome" | "safari" | "firefox" | "edge" | "other" };
  credential?: string;
  attempts: number;
  queuedAt: number;
};

type FreezeDetectorOptions = {
  room: Room;
  connected: boolean;
  videoTrack?: RemoteTrack;
  audioTrack?: RemoteTrack;
  videoElement: HTMLVideoElement | null;
};

const STORAGE_KEY = "avatar-freeze-incident-queue-v1";
const MAX_PENDING_REPORTS = 4;
const RETRY_MS = 15_000;
const MAX_PENDING_AGE_MS = 24 * 60 * 60 * 1_000;

function loadQueue(): StoredIncident[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(value)
      ? value.filter((entry): entry is StoredIncident =>
        typeof entry?.queuedAt === "number" && Date.now() - entry.queuedAt <= MAX_PENDING_AGE_MS,
      ).slice(-MAX_PENDING_REPORTS)
      : [];
  } catch {
    return [];
  }
}

function saveQueue(queue: StoredIncident[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(queue.slice(-MAX_PENDING_REPORTS)));
  } catch {
    // Local persistence is best effort. Do not affect playback for storage errors.
  }
}

function visibleVideo(video: HTMLVideoElement | null): boolean {
  if (!video || video.offsetParent === null) return false;
  const rect = video.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function matchingVideoElement(video: HTMLVideoElement | null, track?: RemoteTrack): boolean {
  if (!video || !track) return false;
  const stream = video.srcObject;
  return stream instanceof MediaStream && stream.getVideoTracks().some((item) => item.id === track.mediaStreamTrack.id);
}

function browserLabel(): "chrome" | "safari" | "firefox" | "edge" | "other" {
  const userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent.toLowerCase();
  if (userAgent.includes("edg/")) return "edge";
  if (userAgent.includes("firefox/")) return "firefox";
  if (userAgent.includes("chrome/") || userAgent.includes("crios/")) return "chrome";
  if (userAgent.includes("safari/")) return "safari";
  return "other";
}

function observedVideoElement(video: HTMLVideoElement | null, track?: RemoteTrack): HTMLVideoElement | null {
  if (typeof document === "undefined") return null;
  const candidates = [video, ...Array.from(document.querySelectorAll<HTMLVideoElement>("video[data-freeze-agent-video]"))]
    .filter((candidate): candidate is HTMLVideoElement => !!candidate);
  return candidates.find((candidate) => matchingVideoElement(candidate, track) && visibleVideo(candidate)) ?? null;
}

const pendingStats = new WeakMap<RemoteTrack, Promise<RTCStatsReport | undefined>>();

async function boundedStats(track?: RemoteTrack): Promise<RTCStatsReport | undefined> {
  if (!track) return undefined;
  let request = pendingStats.get(track);
  if (!request) {
    request = Promise.resolve().then(() => track.getRTCStatsReport()).catch(() => undefined)
      .finally(() => pendingStats.delete(track));
    pendingStats.set(track, request);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request,
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), 750); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function boundedFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 10_000);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
  }
}

function parseServerTime(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value > 1e12 ? value : value * 1_000;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

/**
 * Observes receiver counters and displayed frames only. It never records media,
 * alters receiver buffering, controls the microphone, or touches agent state.
 */
export function useFreezeDetector({
  room,
  connected,
  videoTrack,
  audioTrack,
  videoElement,
}: FreezeDetectorOptions) {
  const detector = useRef(new FreezeDetector());
  const queue = useRef<StoredIncident[]>([]);
  const latest = useRef({ room, connected, videoTrack, audioTrack, videoElement });
  const frame = useRef({ firstAt: 0, lastAt: 0, lastGapAt: 0 });
  const longTasks = useRef({ count: 0, durationMs: 0, maxDurationMs: 0 });
  const uploading = useRef(false);
  const hasObservedTrack = useRef(false);
  const [reportStatus, setReportStatus] = useState<FreezeReportStatus>({ state: "idle" });

  latest.current = { room, connected, videoTrack, audioTrack, videoElement };

  const upload = useCallback(async () => {
    if (uploading.current || !queue.current.length || !navigator.onLine) return;
    uploading.current = true;
    const entry = queue.current[0];
    try {
      if (Date.now() - entry.queuedAt > MAX_PENDING_AGE_MS) {
        queue.current.shift();
        saveQueue(queue.current);
        return;
      }
      let credential = entry.credential;
      if (!credential) {
        const requestStarted = Date.now();
        const response = await boundedFetch(`/api/incidents?room=${encodeURIComponent(entry.report.room)}`, {
          credentials: "include",
          cache: "no-store",
        });
        if (!response.ok) throw new Error("Could not prepare the report.");
        const payload = await response.json() as { credential?: unknown; room?: unknown; serverTime?: unknown };
        if (typeof payload.credential !== "string" || payload.room !== entry.report.room) {
          throw new Error("Could not prepare the report.");
        }
        credential = payload.credential;
        const serverTime = parseServerTime(payload.serverTime);
        if (serverTime !== undefined) {
          // Preserve client UTC timestamps. The offset is separate evidence for
          // correlating those timestamps with the server log clock.
          const offset = serverTime - (requestStarted + Date.now()) / 2;
          if (Math.abs(offset) <= 7 * 24 * 60 * 60 * 1_000) entry.report.serverClockOffsetMs = Math.round(offset);
        }
        entry.credential = credential;
        saveQueue(queue.current);
      }
      const response = await boundedFetch("/api/incidents", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${credential}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(entry.report),
        keepalive: true,
      });
      if ([400, 401, 403, 409, 413].includes(response.status)) {
        queue.current.shift();
        saveQueue(queue.current);
        setReportStatus({ state: "error", message: "This report could not be saved. Please report again if the problem continues." });
        return;
      }
      if (!response.ok) throw new Error("Could not save the report.");
      const payload = await response.json().catch(() => ({})) as { id?: unknown };
      queue.current.shift();
      saveQueue(queue.current);
      setReportStatus({ state: "saved", id: typeof payload.id === "string" ? payload.id : entry.report.id });
    } catch {
      entry.attempts += 1;
      // Preserve the room-scoped capability across network failures; its
      // original cookie may have been pruned after another session started.
      saveQueue(queue.current);
      setReportStatus({ state: "error", message: "Couldn’t save the report. We’ll try again." });
    } finally {
      uploading.current = false;
    }
  }, []);

  const enqueue = useCallback((report: FreezeIncidentDraft) => {
    if (!report.room) return;
    queue.current = [
      ...queue.current,
      { report: { ...report, room: report.room, browser: browserLabel() }, attempts: 0, queuedAt: Date.now() },
    ].slice(-MAX_PENDING_REPORTS);
    saveQueue(queue.current);
    void upload();
  }, [upload]);

  useEffect(() => {
    queue.current = loadQueue();
    void upload();
    const retry = window.setInterval(() => void upload(), RETRY_MS);
    const online = () => void upload();
    window.addEventListener("online", online);
    const pageHide = () => {
      detector.current.flushPending();
      for (const report of detector.current.drainReady()) enqueue(report);
    };
    window.addEventListener("pagehide", pageHide);
    return () => {
      window.clearInterval(retry);
      window.removeEventListener("online", online);
      window.removeEventListener("pagehide", pageHide);
    };
  }, [upload, enqueue]);

  useEffect(() => {
    if (!connected) {
      detector.current.flushPending();
      for (const report of detector.current.drainReady()) enqueue(report);
      // A later connection must not inherit another room's pre-incident window.
      detector.current = new FreezeDetector();
      hasObservedTrack.current = false;
      frame.current = { firstAt: 0, lastAt: 0, lastGapAt: 0 };
    }
  }, [connected, enqueue]);

  useEffect(() => () => {
    detector.current.flushPending();
    for (const report of detector.current.drainReady()) enqueue(report);
  }, [enqueue]);

  const videoIdentity = videoTrack?.mediaStreamTrack.id;
  const audioIdentity = audioTrack?.mediaStreamTrack.id;
  useEffect(() => {
    if (!videoIdentity && !audioIdentity) return;
    detector.current.resetTrack(hasObservedTrack.current);
    hasObservedTrack.current = true;
    frame.current = { firstAt: 0, lastAt: 0, lastGapAt: 0 };
  }, [videoIdentity, audioIdentity]);

  useEffect(() => {
    if (!videoTrack) return;
    let cancelled = false;
    let callbackId = 0;
    type FrameCallbackVideo = HTMLVideoElement & {
      requestVideoFrameCallback?: (callback: () => void) => number;
      cancelVideoFrameCallback?: (id: number) => void;
    };
    let observed: FrameCallbackVideo | null = null;
    const stop = () => {
      const current = observed as FrameCallbackVideo | null;
      if (callbackId && current?.cancelVideoFrameCallback) current.cancelVideoFrameCallback(callbackId);
      callbackId = 0;
    };
    const observe = () => {
      if (cancelled) return;
      const now = performance.now();
      const element = observed;
      if (element && matchingVideoElement(element, videoTrack) && visibleVideo(element)) {
        if (!frame.current.firstAt) frame.current.firstAt = now;
        frame.current.lastAt = now;
        frame.current.lastGapAt = 0;
      }
      if (element?.requestVideoFrameCallback) callbackId = element.requestVideoFrameCallback(observe);
    };
    const rebind = () => {
      const next = observedVideoElement(videoElement, videoTrack) as FrameCallbackVideo | null;
      if (next === observed) return;
      stop();
      detector.current.suspend();
      observed = next;
      frame.current = { firstAt: 0, lastAt: 0, lastGapAt: 0 };
      if (observed?.requestVideoFrameCallback) callbackId = observed.requestVideoFrameCallback(observe);
    };
    rebind();
    const watchLayout = window.setInterval(rebind, 250);
    return () => {
      cancelled = true;
      window.clearInterval(watchLayout);
      stop();
    };
  }, [videoElement, videoTrack, videoIdentity]);

  useEffect(() => {
    if (typeof PerformanceObserver === "undefined") return;
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTasks.current.count += 1;
        longTasks.current.durationMs += entry.duration;
        longTasks.current.maxDurationMs = Math.max(longTasks.current.maxDurationMs, entry.duration);
      }
    });
    try {
      observer.observe({ type: "longtask", buffered: true });
    } catch {
      // Some browsers do not expose long-task entries.
    }
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    const collect = async () => {
      const current = latest.current;
      const now = performance.now();
      const observed = observedVideoElement(current.videoElement, current.videoTrack);
      const shown = !!observed;
      const playing = !!observed && !observed.paused && !observed.ended && observed.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
      const frameGap = frame.current.lastAt && shown && playing ? now - frame.current.lastAt : undefined;
      const watchdogGap = frameGap && frameGap >= 500 ? frameGap : undefined;
      const [videoReport, audioReport] = await Promise.all([
        boundedStats(current.videoTrack),
        boundedStats(current.audioTrack),
      ]);
      if (cancelled) return;
      const longTask = longTasks.current;
      longTasks.current = { count: 0, durationMs: 0, maxDurationMs: 0 };
      detector.current.ingest({
        room: current.room.name,
        monotonicMs: now,
        wallMs: Date.now(),
        connected: current.connected,
        visible: document.visibilityState === "visible",
        videoVisible: shown,
        videoPlaying: playing,
        hasFirstFrame: frame.current.firstAt > 0,
        frameGapMs: watchdogGap,
        longTaskCount: longTask.count || undefined,
        longTaskDurationMs: longTask.durationMs || undefined,
        longTaskMaxDurationMs: longTask.maxDurationMs || undefined,
        video: readInboundReceiverStats(videoReport, "video"),
        audio: readInboundReceiverStats(audioReport, "audio"),
      });
      for (const report of detector.current.drainReady()) enqueue(report);
    };
    void collect();
    const interval = window.setInterval(() => void collect(), 1_000);
    const visibility = () => {
      if (document.visibilityState !== "visible") {
        // A stale rVFC timestamp after backgrounding must never become a visible freeze.
        detector.current.suspend();
        frame.current = { firstAt: 0, lastAt: 0, lastGapAt: 0 };
      }
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [connected, enqueue, videoIdentity, audioIdentity]);

  const reportFreeze = useCallback(() => {
    const current = latest.current;
    if (!current.connected || !current.room.name) return;
    setReportStatus({ state: "saving" });
    const now = performance.now();
    detector.current.manual({
      room: current.room.name,
      monotonicMs: now,
      wallMs: Date.now(),
      connected: true,
      visible: document.visibilityState === "visible",
      videoVisible: !!observedVideoElement(current.videoElement, current.videoTrack),
      videoPlaying: !!observedVideoElement(current.videoElement, current.videoTrack) && !observedVideoElement(current.videoElement, current.videoTrack)?.paused,
      hasFirstFrame: frame.current.firstAt > 0,
    });
  }, [enqueue]);

  return { reportFreeze, reportStatus };
}
