import type { RemoteTrack } from "livekit-client";

export function receiverTargetMs(
  _kind: string,
  _agentName: string | undefined,
  defaultTargetMs: number,
): number {
  // Keep audio and video on the configured target for every agent.
  // The former dev-only 80/0 ms override left too little delivery margin.
  return defaultTargetMs;
}

export function applyReceiverJitterBuffer(
  track: RemoteTrack,
  targetMs: number,
) {
  if (!Number.isFinite(targetMs) || targetMs < 0 || !track.receiver) {
    return;
  }

  // Apply zero explicitly too, so configuration changes reset older targets.
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
