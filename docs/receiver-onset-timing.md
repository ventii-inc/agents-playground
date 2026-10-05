# Development-avatar playback timing

`digital-human-expression-refinement-dev` uses the configured receiver target for
video (`NEXT_PUBLIC_RECEIVER_JITTER_BUFFER_MS`, deployed as 625 ms) and an explicit
0 ms audio target. Other agents retain the shared target for both tracks.
Existing subscriptions, new tracks, and reconnects receive the same policy.

October 5 source/receiver comparisons found steady ~40 ms source publication
cadence while Chrome froze at the prior video80/audio0 setting. On the same
unchanged renderer and Fish s2-pro, video625/audio0 had zero freezes and zero
concealed audio samples in a 35-second test. Matched generated frames led their
input-audio positions mostly by 45–75 ms, compared with roughly 280–400 ms at
80/0. This is generated-frame alignment, not a phoneme-accuracy score. The user
reviewed the received moving clip and approved this setting for release.

The earlier 625/625 experiment was reverted. This change retains audio0 and
increases only the development avatar’s video buffer. It adds video buffering
latency; browser targets are hints, and network conditions can still cause stalls.

Validation: `node --import tsx --test scripts/test-receiver-buffer.ts`, TypeScript,
production build, and hosted receiver inspection without test overrides. Complete
source/receiver evidence is recorded with the paired LiveKit release.

Rollback the scoped mapping to video80/audio0 and deploy the revision. GPU and
voice settings do not need to change for this frontend rollback.

The isolated `digital-human-serverless-test` agent uses the same reviewed
video-only policy, so the internal serverless admin can reuse this playground.
