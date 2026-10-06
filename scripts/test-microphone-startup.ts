import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createMicrophoneStartup,
  microphoneStartsEnabled,
} from "../src/lib/microphoneStartup";

test("redirect must explicitly opt in and show a microphone control", () => {
  assert.equal(microphoneStartsEnabled("#mic=1&mic_unmuted=1&audio=0"), true);
  for (const hash of [
    "",
    "#mic=1",
    "#mic=0&mic_unmuted=1",
    "#mic=1&mic_unmuted=0",
  ]) {
    assert.equal(microphoneStartsEnabled(hash), false);
  }
});

test("connect unmutes once; renders and network reconnects preserve manual mute", async () => {
  const calls: boolean[] = [];
  const apply = createMicrophoneStartup(true, async (enabled) => {
    calls.push(enabled);
  });
  for (const state of [
    "disconnected",
    "connecting",
    "connected",
    "connected",
    "reconnecting",
    "connected",
  ])
    await apply(state);
  assert.deepEqual(calls, [true]);
  await apply("disconnected");
  await apply("connected");
  assert.deepEqual(calls, [true, true]);
});

test("ordinary links keep the existing muted default", async () => {
  const calls: boolean[] = [];
  await createMicrophoneStartup(false, async (enabled) => {
    calls.push(enabled);
  })("connected");
  assert.deepEqual(calls, [false]);
});

test("permission denial is surfaced once, without repeated permission prompts", async () => {
  let calls = 0;
  const apply = createMicrophoneStartup(true, async () => {
    calls++;
    throw new Error("permission denied");
  });
  await assert.rejects(apply("connected"), /permission denied/);
  await apply("connected");
  assert.equal(calls, 1);
});
