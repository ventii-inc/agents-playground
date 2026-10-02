"use client";

import { RemoteTrack, Room, RoomEvent } from "livekit-client";
import { useEffect } from "react";
import {
  applyReceiverJitterBuffer,
  receiverTargetMs,
} from "@/lib/receiverJitterBuffer";

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

export function useReceiverJitterBuffer(
  room: Room,
  agentName?: string,
  targetMs = RECEIVER_JITTER_BUFFER_MS,
) {
  useEffect(() => {
    const apply = (track: RemoteTrack) =>
      applyReceiverJitterBuffer(
        track,
        receiverTargetMs(track.kind, agentName, targetMs),
      );

    // Cover tracks that subscribed before this component effect ran.
    const applyExisting = () =>
      room.remoteParticipants.forEach((participant) => {
        participant.trackPublications.forEach((publication) => {
          if (publication.track) {
            apply(publication.track);
          }
        });
      });

    applyExisting();

    // Apply at subscription time for all future remote audio/video tracks.
    room.on(RoomEvent.TrackSubscribed, apply);
    room.on(RoomEvent.Reconnected, applyExisting);
    return () => {
      room.off(RoomEvent.TrackSubscribed, apply);
      room.off(RoomEvent.Reconnected, applyExisting);
    };
  }, [room, agentName, targetMs]);
}
