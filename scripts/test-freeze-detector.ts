import assert from "node:assert/strict";
import { DetectorInput, FreezeDetector, readInboundReceiverStats } from "../src/lib/freezeDetector";
import { parseIncident } from "../src/lib/server/incidentSchema";

const start = 10_000;

function sample(at: number, patch: Partial<DetectorInput> = {}): DetectorInput {
  return {
    monotonicMs: at,
    wallMs: 1_790_000_000_000 + at,
    connected: true,
    visible: true,
    videoVisible: true,
    videoPlaying: true,
    hasFirstFrame: true,
    video: { freezeCount: 0, totalFreezesDuration: 0, packetsLost: 0, packetsReceived: 100 },
    audio: { concealedSamples: 0, totalSamplesReceived: 48_000 },
    ...patch,
  };
}

function readyAfterCapture(detector: FreezeDetector, at: number) {
  detector.ingest(sample(at));
  const reports = detector.drainReady();
  assert.equal(reports.length, 1);
  return reports[0];
}

// A displayed-frame starvation becomes one watchdog incident after initial
// baseline, not a startup false positive.
{
  const detector = new FreezeDetector();
  detector.ingest(sample(start));
  detector.ingest(sample(start + 1_000, { frameGapMs: 750 }));
  const report = readyAfterCapture(detector, start + 12_000);
  assert.equal(report.reason, "video_watchdog");
  assert.equal(report.samples.some((entry) => entry.video?.displayFrameGapMs === 750), true);
  assert.match(report.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(report.samples.every((entry) =>
    typeof entry.capturedAt === "string" &&
    typeof entry.monotonicMs === "number" &&
    (Object.keys(entry.video ?? {}).length > 0 || Object.keys(entry.audio ?? {}).length > 0),
  ), true);
  const handlerPayload = { ...report, room: "browser-fixture-room", browser: "chrome" as const };
  assert.equal(parseIncident(handlerPayload)?.id, report.id);
}

// Native counters near the watchdog are coalesced and preferred as evidence.
{
  const detector = new FreezeDetector();
  detector.ingest(sample(start));
  detector.ingest(sample(start + 1_000, { frameGapMs: 700 }));
  detector.ingest(sample(start + 2_000, {
    video: { freezeCount: 1, totalFreezesDuration: 0.7, packetsLost: 3, packetsReceived: 120 },
  }));
  const report = readyAfterCapture(detector, start + 13_000);
  assert.equal(report.reason, "rtc_freeze");
  assert.equal(report.samples.some((entry) => entry.video?.freezeCount === 1), true);
  assert.equal(report.likelyCause, "network_delivery_uncertain");
}

// Concealment is an explicit audio signal, never inferred from silence.
{
  const detector = new FreezeDetector();
  detector.ingest(sample(start));
  detector.ingest(sample(start + 1_000, {
    audio: { concealedSamples: 6_000, totalSamplesReceived: 96_000 },
  }));
  const report = readyAfterCapture(detector, start + 12_000);
  assert.equal(report.reason, "audio_concealment");
  assert.equal(report.samples.some((entry) => entry.audio?.concealedSamples === 6_000), true);
}

// A hidden tab may collect counters, but must not blame the server or carry a
// stale watchdog gap into the next visible sample.
{
  const detector = new FreezeDetector();
  detector.ingest(sample(start));
  detector.ingest(sample(start + 1_000, {
    visible: false,
    videoVisible: false,
    videoPlaying: false,
    frameGapMs: 5_000,
    video: { freezeCount: 5, totalFreezesDuration: 5 },
  }));
  detector.ingest(sample(start + 2_000, {
    video: { freezeCount: 5, totalFreezesDuration: 5 },
  }));
  detector.ingest(sample(start + 3_000, {
    video: { freezeCount: 5, totalFreezesDuration: 5 },
  }));
  assert.deepEqual(detector.drainReady(), []);
}

// Replaced tracks/counter resets are marked in evidence and recovery does not
// generate another incident from the reset.
{
  const detector = new FreezeDetector();
  detector.ingest(sample(start, { video: { freezeCount: 7, totalFreezesDuration: 2 } }));
  detector.ingest(sample(start + 1_000, { video: { freezeCount: 2, totalFreezesDuration: 0.2 } }));
  detector.manual(sample(start + 2_000));
  detector.flushPending();
  const report = detector.drainReady()[0];
  assert.equal(report.trackReset, true);
  detector.ingest(sample(start + 20_000));
  assert.deepEqual(detector.drainReady(), []);
}

// Manual reports retain ten seconds of post-click counters, but an in-progress
// report is safely flushed when a disconnect/unmount ends the observation.
{
  const detector = new FreezeDetector();
  detector.ingest(sample(start));
  detector.manual(sample(start + 1_000));
  detector.ingest(sample(start + 5_000, { video: { freezeCount: 1, totalFreezesDuration: 0.4 } }));
  detector.flushPending();
  const report = detector.drainReady()[0];
  assert.equal(report.reason, "manual");
  assert.equal(report.samples.some((entry) => entry.video?.freezeCount === 1), true);
}

console.log("freeze detector tests passed");

// Native freeze evidence alone must not falsely diagnose a decoder problem.
{
  const detector = new FreezeDetector();
  detector.ingest(sample(start, {video: {freezeCount: 0, totalFreezesDuration: 0}}));
  detector.ingest(sample(start + 1000, {video: {freezeCount: 1, totalFreezesDuration: 0.4}}));
  detector.flushPending();
  assert.equal(detector.drainReady()[0].likelyCause, "unknown");
}

// Hidden tabs may run no polling at all; visibility events still reset baseline.
{
  const detector = new FreezeDetector();
  detector.ingest(sample(start, {video: {freezeCount: 0, totalFreezesDuration: 0}}));
  detector.ingest(sample(start + 1000, {video: {freezeCount: 0, totalFreezesDuration: 0}}));
  detector.suspend();
  detector.ingest(sample(start + 60000, {video: {freezeCount: 5, totalFreezesDuration: 30}}));
  detector.ingest(sample(start + 61000, {video: {freezeCount: 5, totalFreezesDuration: 30}}));
  detector.flushPending();
  assert.deepEqual(detector.drainReady(), []);
}

// Hidden-window losses are retained as context, not blamed on visible playback.
{
  const detector = new FreezeDetector();
  detector.ingest(sample(start, {video: {packetsLost: 0}}));
  detector.ingest(sample(start+1000, {visible:false,video:{packetsLost:5}}));
  detector.ingest(sample(start+2000, {video:{packetsLost:5}}));
  detector.manual(sample(start+3000));
  detector.flushPending();
  const report=detector.drainReady()[0];
  assert.equal(report.likelyCause,"unknown");
  assert.equal(report.samples.some(s=>s.visibility==='hidden'),true);
}

// Chrome audio processing counters must survive the shared collector/schema.
{
  const report=new Map([['audio',{type:'inbound-rtp',kind:'audio',totalProcessingDelay:0.12,nackCount:0,framesDecoded:99,packetsReceived:25}]]);
  const stats=readInboundReceiverStats(report as unknown as RTCStatsReport,'audio');
  assert.equal(stats?.totalProcessingDelay,0.12);
  assert.equal(stats?.framesDecoded,undefined);
  const detector=new FreezeDetector();
  detector.ingest(sample(start,{audio:stats}));
  detector.manual(sample(start+1000));detector.flushPending();
  const generated={...detector.drainReady()[0],room:'schema-audio-check',browser:'chrome'};
  assert.ok(parseIncident(generated));
}
