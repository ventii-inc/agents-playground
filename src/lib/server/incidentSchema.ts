export const INCIDENT_REASONS = ["manual", "video_watchdog", "rtc_freeze", "audio_concealment"] as const;
export const BROWSERS = ["chrome", "safari", "firefox", "edge", "other"] as const;
export const VISIBILITIES = ["visible", "hidden", "unknown"] as const;
export const LIKELY_CAUSES = [
  "network_delivery_uncertain",
  "receiver_decode_uncertain",
  "renderer_or_sender_uncertain",
  "unknown",
] as const;

export type IncidentReason = typeof INCIDENT_REASONS[number];
export type IncidentSample = {
  monotonicMs: number;
  capturedAt: string;
  visibility?: "visible" | "hidden" | "unknown";
  videoVisible?: boolean;
  videoPlaying?: boolean;
  video?: Record<string, number>;
  audio?: Record<string, number>;
};
export type FreezeIncident = {
  schemaVersion: 1;
  id: string;
  room: string;
  reason: IncidentReason;
  occurredAt: string;
  monotonicMs: number;
  trackGeneration: number;
  trackReset: boolean;
  browser: typeof BROWSERS[number];
  visibility: typeof VISIBILITIES[number];
  likelyCause?: typeof LIKELY_CAUSES[number];
  watchdogDurationMs?: number;
  serverClockOffsetMs?: number;
  longTaskCount?: number;
  longTaskTotalDurationMs?: number;
  longTaskMaxDurationMs?: number;
  samples: IncidentSample[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROOM = /^[^\u0000-\u001f\u007f]{1,256}$/;
const VIDEO_METRICS = new Set([
  "packetsReceived", "packetsLost", "bytesReceived", "jitter", "jitterBufferDelay",
  "jitterBufferEmittedCount", "framesDecoded", "framesReceived", "framesDropped",
  "framesPerSecond", "freezeCount", "totalFreezesDuration", "keyFramesDecoded", "nackCount", "pliCount",
  "totalDecodeTime", "totalProcessingDelay", "presentedFrames", "displayFrameGapMs", "roundTripTime",
]);
const AUDIO_METRICS = new Set([
  "packetsReceived", "packetsLost", "bytesReceived", "jitter", "jitterBufferDelay",
  "jitterBufferEmittedCount", "concealedSamples", "silentConcealedSamples", "concealmentEvents",
  "totalSamplesReceived", "insertedSamplesForDeceleration", "removedSamplesForAcceleration", "totalAudioEnergy",
  "roundTripTime",
]);
const INCIDENT_FIELDS = new Set([
  "schemaVersion", "id", "room", "reason", "occurredAt", "monotonicMs", "trackGeneration", "trackReset",
  "browser", "visibility", "likelyCause", "watchdogDurationMs", "serverClockOffsetMs", "longTaskCount",
  "longTaskTotalDurationMs", "longTaskMaxDurationMs", "samples",
]);
const SAMPLE_FIELDS = new Set(["monotonicMs", "capturedAt", "visibility", "videoVisible", "videoPlaying", "video", "audio"]);

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function exactFields(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function utc(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 40 || !value.endsWith("Z")) return false;
  const milliseconds = Date.parse(value);
  // A clock that is merely wrong must not hide a genuine receiver incident.
  return Number.isFinite(milliseconds) && Math.abs(milliseconds - Date.now()) < 366 * 24 * 60 * 60 * 1000;
}

function boundedNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1e15;
}

function boundedInteger(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= maximum;
}

function metrics(value: unknown, allowed: Set<string>): value is Record<string, number> {
  const candidate = object(value);
  if (!candidate || Object.keys(candidate).length === 0 || !exactFields(candidate, allowed)) return false;
  return Object.entries(candidate).every(([key, metric]) => allowed.has(key) &&
    (key === "packetsLost"
      ? typeof metric === "number" && Number.isFinite(metric) && Math.abs(metric) <= 1e15
      : boundedNumber(metric)));
}

function sample(value: unknown): value is IncidentSample {
  const candidate = object(value);
  if (!candidate || !exactFields(candidate, SAMPLE_FIELDS) || !boundedNumber(candidate.monotonicMs) || !utc(candidate.capturedAt)) return false;
  if (candidate.visibility !== undefined && !VISIBILITIES.includes(candidate.visibility as typeof VISIBILITIES[number])) return false;
  if (candidate.videoVisible !== undefined && typeof candidate.videoVisible !== "boolean") return false;
  if (candidate.videoPlaying !== undefined && typeof candidate.videoPlaying !== "boolean") return false;
  if (candidate.video !== undefined && !metrics(candidate.video, VIDEO_METRICS)) return false;
  return (candidate.video !== undefined || candidate.audio !== undefined) &&
    (candidate.audio === undefined || metrics(candidate.audio, AUDIO_METRICS));
}

export function parseIncident(value: unknown): FreezeIncident | undefined {
  const candidate = object(value);
  if (!candidate || !exactFields(candidate, INCIDENT_FIELDS)) return undefined;
  if (candidate.schemaVersion !== 1 || typeof candidate.id !== "string" || !UUID.test(candidate.id) ||
      typeof candidate.room !== "string" || !ROOM.test(candidate.room) ||
      !INCIDENT_REASONS.includes(candidate.reason as IncidentReason) || !utc(candidate.occurredAt) ||
      !boundedNumber(candidate.monotonicMs) || !boundedInteger(candidate.trackGeneration, 10_000) ||
      typeof candidate.trackReset !== "boolean" ||
      !BROWSERS.includes(candidate.browser as typeof BROWSERS[number]) ||
      !VISIBILITIES.includes(candidate.visibility as typeof VISIBILITIES[number]) ||
      (candidate.likelyCause !== undefined && !LIKELY_CAUSES.includes(candidate.likelyCause as typeof LIKELY_CAUSES[number])) ||
      (candidate.watchdogDurationMs !== undefined && !boundedNumber(candidate.watchdogDurationMs)) ||
      (candidate.serverClockOffsetMs !== undefined && (typeof candidate.serverClockOffsetMs !== "number" ||
        !Number.isFinite(candidate.serverClockOffsetMs) || Math.abs(candidate.serverClockOffsetMs) > 7 * 24 * 60 * 60 * 1000)) ||
      (candidate.longTaskCount !== undefined && !boundedInteger(candidate.longTaskCount, 10_000)) ||
      (candidate.longTaskTotalDurationMs !== undefined && !boundedNumber(candidate.longTaskTotalDurationMs)) ||
      (candidate.longTaskMaxDurationMs !== undefined && !boundedNumber(candidate.longTaskMaxDurationMs)) ||
      !Array.isArray(candidate.samples) || candidate.samples.length > 45 || !candidate.samples.every(sample)) return undefined;
  return candidate as FreezeIncident;
}
