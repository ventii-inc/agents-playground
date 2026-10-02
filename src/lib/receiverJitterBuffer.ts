import type { RemoteTrack } from "livekit-client";

const REVIEWED_DEV_AGENT = "digital-human-expression-refinement-dev";

export function receiverTargetMs(
  kind: string,
  agentName: string | undefined,
  defaultTargetMs: number,
): number {
  if (agentName === REVIEWED_DEV_AGENT) {
    return kind === "video" ? 80 : 0;
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
