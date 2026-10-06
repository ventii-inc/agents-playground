// Shared numeric allowlists keep collection and ingestion in agreement.
export const VIDEO_METRIC_KEYS = [
  "packetsReceived", "packetsLost", "bytesReceived", "jitter", "jitterBufferDelay",
  "jitterBufferEmittedCount", "framesDecoded", "framesReceived", "framesDropped",
  "framesPerSecond", "freezeCount", "totalFreezesDuration", "keyFramesDecoded", "nackCount", "pliCount",
  "totalDecodeTime", "totalProcessingDelay", "presentedFrames", "displayFrameGapMs", "roundTripTime",
] as const;
export const AUDIO_METRIC_KEYS = [
  "packetsReceived", "packetsLost", "bytesReceived", "jitter", "jitterBufferDelay",
  "jitterBufferEmittedCount", "concealedSamples", "silentConcealedSamples", "concealmentEvents",
  "totalSamplesReceived", "insertedSamplesForDeceleration", "removedSamplesForAcceleration", "totalAudioEnergy",
  "roundTripTime", "totalProcessingDelay", "totalDecodeTime", "nackCount",
] as const;
