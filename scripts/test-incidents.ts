import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import type { NextApiRequest, NextApiResponse } from "next";
import handleIncidents from "../src/pages/api/incidents";
import {
  diagnosticsCookie,
  diagnosticsCookieCleanup,
  diagnosticsCookieName,
  mintCapability,
} from "@/lib/server/incidentAuth";
import { rememberIncident, trackedRoomCount } from "@/lib/server/incidentStore";
import type { FreezeIncident } from "@/lib/server/incidentSchema";

process.env.LIVEKIT_API_SECRET = "test-livekit-secret-not-a-real-credential";

type Result = { statusCode: number; body: unknown; headers: Record<string, string | string[]> };

function response(): [NextApiResponse, Result] {
  const result: Result = { statusCode: 200, body: undefined, headers: {} };
  const value = {
    setHeader(name: string, header: string | string[]) { result.headers[name] = header; return value; },
    status(code: number) { result.statusCode = code; return value; },
    json(body: unknown) { result.body = body; return value; },
  };
  return [value as unknown as NextApiResponse, result];
}

function report(room: string, id = randomUUID()): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id,
    room,
    reason: "rtc_freeze",
    occurredAt: new Date().toISOString(),
    monotonicMs: 1000,
    trackGeneration: 2,
    trackReset: false,
    browser: "chrome",
    visibility: "visible",
      likelyCause: "network_delivery_uncertain",
    watchdogDurationMs: 1200,
    serverClockOffsetMs: -42,
    longTaskCount: 1,
    longTaskTotalDurationMs: 32,
    longTaskMaxDurationMs: 32,
    samples: [{
      monotonicMs: 900,
      capturedAt: new Date().toISOString(),
      video: { framesDecoded: 100, freezeCount: 1, totalFreezesDuration: 0.25, totalDecodeTime: 0.3,
        totalProcessingDelay: 0.2, presentedFrames: 98, displayFrameGapMs: 210, roundTripTime: 0.04 },
      audio: { concealedSamples: 12, totalSamplesReceived: 48000, packetsLost: -1, roundTripTime: 0.04 },
    }],
  };
}

function request(room: string, body: unknown, credential = mintCapability(room, "credential", 60)): NextApiRequest {
  return {
    method: "POST",
    body,
    headers: {
      host: "playground.example.test",
      origin: "https://playground.example.test",
      authorization: `Bearer ${credential}`,
      "content-type": "application/json",
    },
  } as unknown as NextApiRequest;
}

function invoke(req: NextApiRequest): Result {
  const [res, result] = response();
  handleIncidents(req, res);
  return result;
}

test("POST accepts only the room-bound telemetry schema and writes a sanitized structured log", () => {
  const room = `room-log-${randomUUID()}`;
  const logs: string[] = [];
  const original = console.info;
  console.info = (value: string) => { logs.push(value); };
  try {
    const result = invoke(request(room, report(room)));
    assert.equal(result.statusCode, 200);
    assert.equal(result.headers["Cache-Control"], "no-store");
    assert.deepEqual(result.body && (result.body as Record<string, unknown>).stored, true);
    assert.equal(logs.length, 1);
    const entry = JSON.parse(logs[0]) as Record<string, unknown>;
    assert.equal(entry.event, "avatar_freeze_incident");
    assert.equal(entry.room, room);
    assert.equal(logs[0].includes("test-livekit-secret"), false);
    assert.equal(logs[0].includes("participant_token"), false);
  } finally {
    console.info = original;
  }
});

test("POST rejects missing, mismatched, and expired-equivalent diagnostics credentials", () => {
  const room = `room-auth-${randomUUID()}`;
  const missing = request(room, report(room));
  delete missing.headers.authorization;
  assert.equal(invoke(missing).statusCode, 401);
  assert.equal(invoke(request(room, report(room), mintCapability(`other-${room}`, "credential", 60))).statusCode, 401);
  assert.equal(invoke(request(room, report(room), mintCapability(room, "cookie", 60))).statusCode, 401);
  assert.equal(invoke(request(room, report(room), mintCapability(room, "credential", -1))).statusCode, 401);
});

test("POST rejects unsafe fields, wrong origin, and declared oversized bodies without logging", () => {
  const room = `room-invalid-${randomUUID()}`;
  const logs: string[] = [];
  const original = console.info;
  console.info = (value: string) => { logs.push(value); };
  try {
    const media = report(room) as Record<string, unknown>;
    media.transcript = "do not accept";
    assert.equal(invoke(request(room, media)).statusCode, 400);
    const origin = request(room, report(room));
    origin.headers.origin = "https://attacker.invalid";
    assert.equal(invoke(origin).statusCode, 403);
    const large = request(room, report(room));
    large.headers["content-length"] = "65537";
    assert.equal(invoke(large).statusCode, 413);
    const tooMany = report(room) as Record<string, unknown>;
    tooMany.samples = Array.from({ length: 46 }, () => ({
      monotonicMs: 1,
      capturedAt: new Date().toISOString(),
      video: { framesDecoded: 1 },
    }));
    assert.equal(invoke(request(room, tooMany)).statusCode, 400);
    assert.equal(logs.length, 0);
  } finally {
    console.info = original;
  }
});

test("POST deduplicates incident ids and bounds reports per room", () => {
  const room = `room-rate-${randomUUID()}`;
  const id = randomUUID();
  const first = invoke(request(room, report(room, id)));
  const duplicate = invoke(request(room, report(room, id)));
  assert.equal(first.statusCode, 200);
  assert.equal(duplicate.statusCode, 200);
  assert.deepEqual((duplicate.body as Record<string, unknown>).duplicate, true);
  for (let index = 0; index < 5; index += 1) assert.equal(invoke(request(room, report(room))).statusCode, 200);
  assert.equal(invoke(request(room, report(room))).statusCode, 429);
});

test("GET exchanges only the matching room cookie for a telemetry credential", () => {
  const room = `room-cookie-${randomUUID()}`;
  const cookie = diagnosticsCookie(room, Date.now(), false).split(";", 1)[0];
  const req = {
    method: "GET",
    query: { room },
    headers: { cookie },
  } as unknown as NextApiRequest;
  const [res, result] = response();
  handleIncidents(req, res);
  assert.equal(result.statusCode, 200);
  assert.equal((result.body as Record<string, unknown>).room, room);
  const mismatch = {
    method: "GET",
    query: { room: `other-${room}` },
    headers: { cookie: `${diagnosticsCookieName(room)}=${cookie.split("=")[1]}` },
  } as unknown as NextApiRequest;
  assert.equal(invoke(mismatch).statusCode, 401);
});

test("GET-style cookie cleanup keeps the current room plus at most seven other recent rooms", () => {
  const currentRoom = `room-current-${randomUUID()}`;
  const currentName = diagnosticsCookieName(currentRoom);
  const cookies = [diagnosticsCookie(currentRoom, Date.now(), false).split(";", 1)[0]];
  for (let index = 0; index < 10; index += 1) {
    cookies.push(diagnosticsCookie(`room-old-${index}-${randomUUID()}`, Date.now() - index * 1000, false).split(";", 1)[0]);
  }
  const cleanup = diagnosticsCookieCleanup(cookies.join("; "), currentName, Date.now(), false);
  assert.equal(cleanup.length, 3);
  assert.ok(cleanup.every((header) => header.includes("Path=/api/incidents") && header.includes("Max-Age=0")));
  assert.equal(cleanup.some((header) => header.startsWith(`${currentName}=`)), false);
});

test("POST recognizes localhost development origins and proxied App Hosting origins", () => {
  const localRoom = `room-local-${randomUUID()}`;
  const local = request(localRoom, report(localRoom));
  local.headers.host = "localhost:3167";
  local.headers.origin = "http://localhost:3167";
  assert.equal(invoke(local).statusCode, 200);
  const hostedRoom = `room-hosted-${randomUUID()}`;
  const hosted = request(hostedRoom, report(hostedRoom));
  hosted.headers.host = "internal-function";
  hosted.headers.origin = "https://playground.example.test";
  hosted.headers["x-forwarded-host"] = "playground.example.test";
  hosted.headers["x-forwarded-proto"] = "https";
  assert.equal(invoke(hosted).statusCode, 200);
});

test("in-memory rate state remains bounded across many distinct rooms", () => {
  for (let index = 0; index < 520; index += 1) {
    const room = `room-bounded-${index}-${randomUUID()}`;
    assert.equal(rememberIncident(report(room) as unknown as FreezeIncident), "accepted");
  }
  assert.ok(trackedRoomCount() <= 500);
});
