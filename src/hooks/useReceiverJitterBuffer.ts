"use client";

import { RemoteTrack, Room, RoomEvent } from "livekit-client";
import { useEffect } from "react";

export const DEFAULT_RECEIVER_JITTER_BUFFER_MS = 625;

function configuredTargetMs(): number {
  const configured = Number(
    process.env.NEXT_PUBLIC_RECEIVER_JITTER_BUFFER_MS ??
      DEFAULT_RECEIVER_JITTER_BUFFER_MS,
  );
  return Number.isFinite(configured) && configured >= 0
    ? configured
    : DEFAULT_RECEIVER_JITTER_BUFFER_MS;
}

export const RECEIVER_JITTER_BUFFER_MS = configuredTargetMs();

function applyReceiverJitterBuffer(track: RemoteTrack, targetMs: number) {
  if (targetMs <= 0 || !track.receiver) {
    return;
  }

  // Match the measured experiment: set both the explicit jitter-buffer target
  // (milliseconds) and LiveKit's playout-delay hint (seconds). Apply this to
  // audio and video tracks so the added latency remains lip-synced.
  try {
    track.receiver.jitterBufferTarget = targetMs;
  } catch {
    // Older browsers may expose a read-only/unsupported receiver property.
  }
  track.setPlayoutDelay(targetMs / 1000);
}

export function useReceiverJitterBuffer(
  room: Room,
  targetMs = RECEIVER_JITTER_BUFFER_MS,
) {
  useEffect(() => {
    const apply = (track: RemoteTrack) =>
      applyReceiverJitterBuffer(track, targetMs);

    // Cover tracks that subscribed before this component effect ran.
    room.remoteParticipants.forEach((participant) => {
      participant.trackPublications.forEach((publication) => {
        if (publication.track) {
          apply(publication.track);
        }
      });
    });

    // Apply at subscription time for all future remote audio/video tracks.
    room.on(RoomEvent.TrackSubscribed, apply);
    return () => {
      room.off(RoomEvent.TrackSubscribed, apply);
    };
  }, [room, targetMs]);
}
