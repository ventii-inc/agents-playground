# Matched receiver playback buffers

All agents, including `digital-human-expression-refinement-dev`, use the same
configured target for audio and video: `NEXT_PUBLIC_RECEIVER_JITTER_BUFFER_MS`
(default and deployed value: 625 ms). The hook covers existing tracks, new
subscriptions, and reconnection. Zero remains a valid explicit reset.

The former dev-only 80 ms video / 0 ms audio override improved onset alignment
in the October 2 review, but October 5 receiver tests reproduced 18–22 freezes
per 30 seconds and 0.306–0.441 seconds of concealed audio. Matched 625 ms targets
reduced these to 0–2 freezes and 0–0.271 seconds of concealed audio in two trials.
This is a mitigation, not proof of a complete transport fix. Targets are browser
requests; actual residence time and added latency depend on delivery conditions.
Moving lip-sync still requires review. GPU and voice settings are unchanged.

Validation:

```sh
node --import tsx --test scripts/test-receiver-buffer.ts
pnpm exec tsc --noEmit
pnpm run build
```

For a live smoke test, select the development agent and inspect the active
subscribed audio and video receivers: both targets should be 625. Observe
settings without injecting recorder overrides. Check short, long, and successive
replies, freeze/concealment counters, buffer residence, and moving lip-sync.
Unsupported browser controls must not block connection.

Rollback by reverting this change and deploying the revision; that restores the
dev-only 80/0 ms mapping. No pod restart is needed.
