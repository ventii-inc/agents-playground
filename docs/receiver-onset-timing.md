# Reviewed development-avatar receiver timing

For `digital-human-expression-refinement-dev`, apply a video receiver target of
80 ms and an audio target of 0 ms. The setting follows the selected agent on
existing tracks, new subscriptions, and reconnection. Other agents retain the
configured shared target (`NEXT_PUBLIC_RECEIVER_JITTER_BUFFER_MS`, default 625).
Zero must be applied explicitly to clear an earlier audio target.

The user reviewed and approved the 80 ms test on 2026-10-02. Exact-input and
generated-frame matching in the avatar repository measured first-three-second
received video lead of about 93 ms before and 35 ms with this target; later
windows were near zero. These are two individual development runs, not a
universal browser/network guarantee or a phoneme-accuracy score. No avatar
expression library, lip gain, voice credential, or GPU service changes are
required by this frontend change.

Validation:

```sh
node --import tsx --test scripts/test-receiver-buffer.ts
pnpm exec tsc --noEmit
pnpm run build
```

For a live smoke test, select the development agent, connect, and inspect both
receivers: audio `jitterBufferTarget` should be 0 and video should be 80. Record
from before the prompt so speech onset is included. The recorder must observe
receiver settings rather than writing its own target, or it will invalidate
this check. Unsupported browser controls fail without blocking the room.

Rollback the scoped mapping in `src/lib/receiverJitterBuffer.ts` to return the
shared target for this agent and deploy that revision. Production agent names
are not opted into this experiment.
