# Main avatar receiver playback comparison

The main `digital-human-serverless-test` agent now uses the configured receiver
buffer target for both audio and video: 625 ms in App Hosting. Previously the
frontend forced this agent's audio target to zero while retaining 625 ms video.
The older `digital-human-expression-refinement-dev` experiment retains its zero
audio target. Avatar assets, expressions, backend motion settings and other
agents are unchanged.

These values are browser hints, not guaranteed delay or a measured sync offset.
This change enables the user-requested live comparison; it does not establish
that buffering caused the reported regression. Reload and reconnect after the
rollout. Check short and long speech before accepting lip-sync quality. Reverting
this change restores the main agent's zero audio target.
