import assert from "node:assert/strict";
import { test } from "node:test";
import type { RemoteTrack } from "livekit-client";
import {
  applyReceiverJitterBuffer,
  receiverTargetMs,
} from "../src/lib/receiverJitterBuffer";

const reviewedAgent = "digital-human-expression-refinement-dev";

test("the reviewed target is isolated from production and other agents", () => {
  for (const agent of [
    undefined,
    "",
    "digital-human",
    "digital-human-other-dev",
  ]) {
    for (const kind of ["audio", "video"]) {
      assert.equal(receiverTargetMs(kind, agent, 625), 625);
      assert.equal(receiverTargetMs(kind, agent, 240), 240);
    }
  }
  assert.equal(receiverTargetMs("audio", reviewedAgent, 625), 0);
  assert.equal(receiverTargetMs("video", reviewedAgent, 625), 80);
});

test("zero resets an existing audio target and both supported APIs agree", () => {
  const receiver = { jitterBufferTarget: 625 };
  let delay = 0.625;
  const track = {
    receiver,
    setPlayoutDelay: (value: number) => {
      delay = value;
    },
  } as unknown as RemoteTrack;
  applyReceiverJitterBuffer(track, 0);
  assert.equal(receiver.jitterBufferTarget, 0);
  assert.equal(delay, 0);
  applyReceiverJitterBuffer(track, 80);
  assert.equal(receiver.jitterBufferTarget, 80);
  assert.equal(delay, 0.08);
});

test("unsupported receiver properties and hints do not break connection", () => {
  const receiver = Object.defineProperty({}, "jitterBufferTarget", {
    set: () => {
      throw new Error("unsupported");
    },
  });
  let hintAttempted = false;
  const track = {
    receiver,
    setPlayoutDelay: () => {
      hintAttempted = true;
      throw new Error("unsupported");
    },
  } as unknown as RemoteTrack;
  assert.doesNotThrow(() => applyReceiverJitterBuffer(track, 80));
  assert.ok(hintAttempted);
});
