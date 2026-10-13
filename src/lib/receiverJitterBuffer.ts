import type { RemoteTrack } from "livekit-client";

// Keep the older refinement experiment isolated. The main serverless avatar
// uses the shared target for both audio and video for playback comparison.
const ZERO_AUDIO_TARGET_AGENTS = new Set([
  "digital-human-expression-refinement-dev",
]);

export function receiverTargetMs(
  kind: string,
  agentName: string | undefined,
  defaultTargetMs: number,
): number {
  if (agentName && ZERO_AUDIO_TARGET_AGENTS.has(agentName)) {
    return kind === "video" ? defaultTargetMs : 0;
  }
  return defaultTargetMs;
}

export function applyReceiverJitterBuffer(
  track: RemoteTrack,
  targetMs: number,
) {
  if (!Number.isFinite(targetMs) || targetMs < 0 || !track.receiver) {
    return;
  }

  // Zero is intentional: the reviewed dev setting resets audio's previous
  // target instead of leaving the shared playground default in effect.
  try {
    track.receiver.jitterBufferTarget = targetMs;
  } catch {
    // Older browsers may expose a read-only/unsupported receiver property.
  }
  try {
    track.setPlayoutDelay(targetMs / 1000);
  } catch {
    // Unsupported delay hints must not prevent a room from connecting.
  }
}
