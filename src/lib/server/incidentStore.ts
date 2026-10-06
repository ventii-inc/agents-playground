import { FreezeIncident } from "./incidentSchema";

const RATE_WINDOW_MS = 60_000;
const MAX_PER_ROOM_PER_WINDOW = 6;
const MAX_REMEMBERED_INCIDENTS = 500;
const MAX_TRACKED_ROOMS = 500;

const recentByRoom = new Map<string, number[]>();
const seen = new Map<string, { room: string; expiresAt: number }>();

function prune(now: number): void {
  for (const [room, timestamps] of Array.from(recentByRoom.entries())) {
    const active = timestamps.filter((timestamp) => timestamp > now - RATE_WINDOW_MS);
    if (active.length) recentByRoom.set(room, active);
    else recentByRoom.delete(room);
  }
  for (const [id, entry] of Array.from(seen.entries())) if (entry.expiresAt <= now) seen.delete(id);
  while (seen.size > MAX_REMEMBERED_INCIDENTS) seen.delete(seen.keys().next().value as string);
}

export type StoreResult = "accepted" | "duplicate" | "rate_limited" | "collision";

export function rememberIncident(incident: FreezeIncident, now = Date.now()): StoreResult {
  prune(now);
  const previous = seen.get(incident.id);
  if (previous) return previous.room === incident.room ? "duplicate" : "collision";
  const roomEntries = recentByRoom.get(incident.room) ?? [];
  if (roomEntries.length >= MAX_PER_ROOM_PER_WINDOW) return "rate_limited";
  if (!recentByRoom.has(incident.room)) {
    while (recentByRoom.size >= MAX_TRACKED_ROOMS) {
      const oldestRoom = recentByRoom.keys().next().value as string | undefined;
      if (!oldestRoom) break;
      recentByRoom.delete(oldestRoom);
    }
  }
  roomEntries.push(now);
  recentByRoom.set(incident.room, roomEntries);
  seen.set(incident.id, { room: incident.room, expiresAt: now + 15 * 60_000 });
  return "accepted";
}

export function trackedRoomCount(): number {
  return recentByRoom.size;
}
