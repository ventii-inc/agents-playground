import { VIDEO_METRIC_KEYS, AUDIO_METRIC_KEYS } from "./incidentMetrics";

export type IncidentReason =
  | "manual"
  | "video_watchdog"
  | "rtc_freeze"
  | "audio_concealment";

export type ReceiverStats = Partial<Record<typeof VIDEO_METRIC_KEYS[number] | typeof AUDIO_METRIC_KEYS[number], number>>;

export type DetectorInput = {
  room?: string;
  monotonicMs: number;
  wallMs: number;
  connected: boolean;
  visible: boolean;
  videoVisible: boolean;
  videoPlaying: boolean;
  hasFirstFrame: boolean;
  frameGapMs?: number;
  longTaskCount?: number;
  longTaskDurationMs?: number;
  longTaskMaxDurationMs?: number;
  video?: ReceiverStats;
  audio?: ReceiverStats;
};

/** Receiver evidence only. It deliberately excludes media and transcript data. */
export type IncidentSample = {
  capturedAt: string;
  visibility?: "visible" | "hidden";
  videoVisible?: boolean;
  videoPlaying?: boolean;
  monotonicMs: number;
  video?: Record<string, number>;
  audio?: Record<string, number>;
};

export type FreezeIncidentDraft = {
  schemaVersion: 1;
  id: string;
  reason: IncidentReason;
  occurredAt: string;
  monotonicMs: number;
  visibility: "visible" | "hidden";
  trackGeneration: number;
  trackReset: boolean;
  likelyCause?: string;
  watchdogDurationMs?: number;
  longTaskCount?: number;
  longTaskTotalDurationMs?: number;
  longTaskMaxDurationMs?: number;
  serverClockOffsetMs?: number;
  samples: IncidentSample[];
  /** Local-only routing metadata; stripped before POSTing the strict schema. */
  room?: string;
};

const PRE_INCIDENT_MS = 30_000;
const POST_INCIDENT_MS = 10_000;
const MAX_SAMPLES = 45;
const AUTO_INCIDENT_COOLDOWN_MS = 10_000;
const WATCHDOG_GAP_MS = 500;
const AUDIO_CONCEALMENT_SPIKE = 4_800; // 100 ms at the usual 48 kHz sample rate.

type CounterBaselines = {
  video?: ReceiverStats;
  audio?: ReceiverStats;
};

type PendingIncident = FreezeIncidentDraft & {
  captureUntilMs: number;
  signals: Set<IncidentReason>;
  pendingLongTaskCount: number;
  pendingLongTaskDurationMs: number;
  pendingLongTaskMaxDurationMs: number;
};

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function numericSample(input: DetectorInput): IncidentSample | undefined {
  const add = (stats?: ReceiverStats) => {
    const result: Record<string, number> = {};
    if (!stats) return result;
    for (const [name, value] of Object.entries(stats)) {
      const number = finite(value);
      if (number !== undefined) result[name] = number;
    }
    return result;
  };
  const video = add(input.video);
  const audio = add(input.audio);
  const gap = finite(input.frameGapMs);
  if (gap !== undefined) video.displayFrameGapMs = gap;
  if (!Object.keys(video).length && !Object.keys(audio).length) return undefined;
  return {
    capturedAt: new Date(input.wallMs).toISOString(),
    visibility: input.visible ? "visible" : "hidden",
    videoVisible: input.videoVisible,
    videoPlaying: input.videoPlaying,
    monotonicMs: Math.round(input.monotonicMs),
    ...(Object.keys(video).length ? { video } : {}),
    ...(Object.keys(audio).length ? { audio } : {}),
  };
}

function counterDelta(
  current: ReceiverStats | undefined,
  previous: ReceiverStats | undefined,
  key: keyof ReceiverStats,
): { value?: number; reset: boolean } {
  const now = finite(current?.[key]);
  const before = finite(previous?.[key]);
  if (now === undefined || before === undefined) return { reset: false };
  if (now < before) return { reset: true };
  return { value: now - before, reset: false };
}

function trimSamples(samples: IncidentSample[]): IncidentSample[] {
  return samples.length <= MAX_SAMPLES ? samples : samples.slice(-MAX_SAMPLES);
}

function id(): string {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes).map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Pure, bounded evidence collector. It does not inspect media content or make
 * network requests; the React hook owns browser observation and upload.
 */
export class FreezeDetector {
  private samples: IncidentSample[] = [];
  private baseline: CounterBaselines = {};
  private pending?: PendingIncident;
  private ready: FreezeIncidentDraft[] = [];
  private trackGeneration = 0;
  private forceTrackReset = false;
  private recentTrackReset = false;
  private lastAutoIncidentMs = -Infinity;
  private wasObservable = false;
  private continuousWatchdogStall = false;

  suspend(): void {
    // Background timers may stop entirely; visibility events reset the baseline.
    this.baseline = {};
    this.wasObservable = false;
    this.continuousWatchdogStall = false;
  }

  resetTrack(replacement = true): void {
    this.trackGeneration += 1;
    this.baseline = {};
    this.forceTrackReset = true;
    if (replacement) this.recentTrackReset = true;
  }

  ingest(input: DetectorInput): void {
    const observable = input.connected && input.visible && input.videoVisible && input.videoPlaying && input.hasFirstFrame;
    const videoFreeze = counterDelta(input.video, this.baseline.video, "freezeCount");
    const videoDuration = counterDelta(input.video, this.baseline.video, "totalFreezesDuration");
    const audioConcealment = counterDelta(input.audio, this.baseline.audio, "concealedSamples");
    const reset = this.forceTrackReset || videoFreeze.reset || videoDuration.reset || audioConcealment.reset;
    this.forceTrackReset = false;
    if (reset) this.recentTrackReset = true;

    const sample = numericSample(input);
    if (sample) this.samples = trimSamples([...this.samples, sample].filter((entry) => entry.monotonicMs >= input.monotonicMs - PRE_INCIDENT_MS));
    this.baseline = { video: input.video, audio: input.audio };

    if (this.pending && input.monotonicMs <= this.pending.captureUntilMs) {
      if (sample) this.pending.samples = trimSamples([...this.pending.samples, sample]);
      this.pending.pendingLongTaskCount += input.longTaskCount ?? 0;
      this.pending.pendingLongTaskDurationMs += input.longTaskDurationMs ?? 0;
      this.pending.pendingLongTaskMaxDurationMs = Math.max(this.pending.pendingLongTaskMaxDurationMs, input.longTaskMaxDurationMs ?? 0);
    }
    if (this.pending && input.monotonicMs > this.pending.captureUntilMs) {
      this.finishPending();
    }

    // Do not attribute counters accrued while hidden, paused, disconnected, or
    // before the first observable sample. Their final values still remain in
    // the diagnostic ring buffer, but the next visible sample starts fresh.
    if (!observable || !this.wasObservable) {
      this.wasObservable = observable;
      return;
    }

    const nativeFreeze = (videoFreeze.value ?? 0) > 0 || (videoDuration.value ?? 0) > 0;
    const watchdogFreeze = input.hasFirstFrame && input.videoPlaying && (input.frameGapMs ?? 0) >= WATCHDOG_GAP_MS;
    const audioSpike = (audioConcealment.value ?? 0) >= AUDIO_CONCEALMENT_SPIKE;

    if (!watchdogFreeze) this.continuousWatchdogStall = false;

    if (observable && (nativeFreeze || watchdogFreeze || audioSpike)) {
      if (watchdogFreeze && this.continuousWatchdogStall && !this.pending) return;
      const reason: IncidentReason = nativeFreeze
        ? "rtc_freeze"
        : watchdogFreeze
          ? "video_watchdog"
          : "audio_concealment";
      this.trigger(reason, input, reset);
    }

    this.wasObservable = true;
  }

  manual(input: DetectorInput): void {
    const sample = numericSample(input);
    if (sample) this.samples = trimSamples([...this.samples, sample]);
    if (this.pending) {
      this.pending.reason = "manual";
      this.pending.signals.add("manual");
      this.pending.captureUntilMs = Math.max(this.pending.captureUntilMs, input.monotonicMs + POST_INCIDENT_MS);
      return;
    }
    this.startPending("manual", input, false);
  }

  drainReady(): FreezeIncidentDraft[] {
    const ready = this.ready;
    this.ready = [];
    return ready;
  }

  flushPending(): void {
    if (this.pending) this.finishPending();
  }

  private trigger(reason: IncidentReason, input: DetectorInput, reset: boolean): void {
    if (this.pending && input.monotonicMs <= this.pending.captureUntilMs) {
      this.pending.signals.add(reason);
      // Native counter evidence is stronger than a displayed-frame watchdog,
      // but never overwrite a person’s explicit manual-report intent.
      if (reason === "rtc_freeze" && this.pending.reason !== "manual") this.pending.reason = reason;
      if (reason === "video_watchdog") {
        this.continuousWatchdogStall = true;
        this.pending.watchdogDurationMs = Math.max(
          this.pending.watchdogDurationMs ?? 0,
          Math.round(input.frameGapMs ?? 0),
        );
      }
      return;
    }
    if (input.monotonicMs - this.lastAutoIncidentMs < AUTO_INCIDENT_COOLDOWN_MS) return;
    this.lastAutoIncidentMs = input.monotonicMs;
    this.startPending(reason, input, reset);
  }

  private startPending(reason: IncidentReason, input: DetectorInput, reset: boolean): void {
    if (reason === "video_watchdog") this.continuousWatchdogStall = true;
    const incident = this.create(reason, input, reset, true) as PendingIncident;
    incident.captureUntilMs = input.monotonicMs + POST_INCIDENT_MS;
    incident.signals = new Set([reason]);
    incident.pendingLongTaskCount = input.longTaskCount ?? 0;
    incident.pendingLongTaskDurationMs = input.longTaskDurationMs ?? 0;
    incident.pendingLongTaskMaxDurationMs = input.longTaskMaxDurationMs ?? 0;
    this.pending = incident;
  }

  private create(
    reason: IncidentReason,
    input: DetectorInput,
    trackReset: boolean,
    includePending: boolean,
  ): FreezeIncidentDraft {
    const samples = trimSamples(includePending ? this.samples : [...this.samples]);
    const report: FreezeIncidentDraft = {
      schemaVersion: 1,
      id: id(),
      reason,
      occurredAt: new Date(input.wallMs).toISOString(),
      monotonicMs: Math.round(input.monotonicMs),
      visibility: input.visible ? "visible" : "hidden",
      trackGeneration: this.trackGeneration,
      trackReset: trackReset || this.recentTrackReset,
      likelyCause: likelyCause(reason, samples),
      watchdogDurationMs: reason === "video_watchdog" ? Math.round(input.frameGapMs ?? 0) : undefined,
      ...(input.longTaskCount ? {
        longTaskCount: input.longTaskCount,
        longTaskTotalDurationMs: Math.round(input.longTaskDurationMs ?? 0),
        longTaskMaxDurationMs: Math.round(input.longTaskMaxDurationMs ?? 0),
      } : {}),
      samples,
      room: input.room,
    };
    this.recentTrackReset = false;
    return report;
  }

  private finishPending(): void {
    if (!this.pending) return;
    this.pending.likelyCause = likelyCause(this.pending.reason, this.pending.samples);
    if (this.pending.pendingLongTaskCount) {
      this.pending.longTaskCount = this.pending.pendingLongTaskCount;
      this.pending.longTaskTotalDurationMs = Math.round(this.pending.pendingLongTaskDurationMs);
      this.pending.longTaskMaxDurationMs = Math.round(this.pending.pendingLongTaskMaxDurationMs);
    }
    const {
      captureUntilMs: _captureUntilMs,
      signals: _signals,
      pendingLongTaskCount: _pendingLongTaskCount,
      pendingLongTaskDurationMs: _pendingLongTaskDurationMs,
      pendingLongTaskMaxDurationMs: _pendingLongTaskMaxDurationMs,
      ...report
    } = this.pending;
    this.ready.push(report);
    this.pending = undefined;
  }
}

function likelyCause(_reason: IncidentReason, samples: IncidentSample[]): string | undefined {
  if (!samples.length) return undefined;
  let decoderEvidence = false;
  const observable = (sample: IncidentSample) => sample.visibility !== "hidden" &&
    sample.videoVisible !== false && sample.videoPlaying !== false;
  for (let index = 1; index < samples.length; index++) {
    const before = samples[index - 1], after = samples[index];
    // Don't attribute changes spanning hidden/paused or missing polls to the
    // visible incident; preserve the raw context for subsequent review.
    if (!observable(before) || !observable(after) || after.monotonicMs - before.monotonicMs > 2500) continue;
    for (const kind of ["video", "audio"] as const) {
      const a = before[kind]?.packetsLost, b = after[kind]?.packetsLost;
      if (a !== undefined && b !== undefined && b > a) return "network_delivery_uncertain";
    }
    if (before.video?.framesReceived !== undefined && after.video?.framesReceived !== undefined &&
        before.video.framesDecoded !== undefined && after.video.framesDecoded !== undefined &&
        after.video.framesReceived > before.video.framesReceived &&
        after.video.framesDecoded === before.video.framesDecoded) decoderEvidence = true;
  }
  return decoderEvidence ? "receiver_decode_uncertain" : "unknown";
}

/** Extract only documented numeric inbound-rtp counters from a track report. */
export function readInboundReceiverStats(
  report: RTCStatsReport | undefined,
  kind: "video" | "audio",
): ReceiverStats | undefined {
  if (!report) return undefined;
  let selected: Record<string, unknown> | undefined;
  report.forEach((value) => {
    const stat = value as unknown as Record<string, unknown>;
    if (stat.type === "inbound-rtp" && stat.kind === kind) selected = stat;
  });
  if (!selected) return undefined;
  const allowed = kind === "video" ? VIDEO_METRIC_KEYS : AUDIO_METRIC_KEYS;
  const stats: ReceiverStats = {};
  for (const key of allowed) {
    const value = finite(selected[key]);
    if (value !== undefined) stats[key] = value;
  }
  // Some browsers expose RTT only on the selected candidate pair or a
  // remote-inbound report, rather than on the inbound receiver report.
  if (stats.roundTripTime === undefined) {
    report.forEach((value) => {
      const stat = value as unknown as Record<string, unknown>;
      if (stats.roundTripTime !== undefined) return;
      if (stat.type === "candidate-pair" && stat.state === "succeeded") {
        const rtt = finite(stat.currentRoundTripTime);
        if (rtt !== undefined) stats.roundTripTime = rtt;
      } else if (stat.type === "remote-inbound-rtp") {
        const rtt = finite(stat.roundTripTime);
        if (rtt !== undefined) stats.roundTripTime = rtt;
      }
    });
  }
  return Object.keys(stats).length ? stats : undefined;
}
