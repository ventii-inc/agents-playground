# Deployment — Firebase App Hosting

The playground is deployed to **Firebase App Hosting**, which builds from GitHub
and serves the Next.js app on Cloud Run.

## Live deployment

| | |
| --- | --- |
| **URL** | https://agent-playground--video-clone-504ba.asia-east1.hosted.app |
| **Firebase project** | `video-clone-504ba` (display name: `video-clone`) |
| **Backend** | `agent-playground` |
| **Region** | `asia-east1` |
| **Repository** | `ventii-inc/agents-playground` |
| **Tracked branch** | `main` |
| **Root directory** | `/` |
| **Console** | https://console.firebase.google.com/project/video-clone-504ba/apphosting |

The GitHub App Hosting integration rolls out commits from `main`. Verified on
2026-10-02 against the successful Firebase rollout check for `64c4b57` (the
latest deployed frontend commit before the receiver-timing change). The older
`feature/video-recording` branch is no longer the deployment baseline.

The project also hosts an unrelated `clone-video` backend. Leave it alone.

## Deploying

Create and validate a pull request into `main`. Merging it triggers the GitHub
App Hosting integration. Confirm the `App Hosting - Rollout` check succeeds on
the merged commit before reporting deployment complete, then verify the served
bundle and a real session.

For a manual rollout, the Firebase CLI requires a current login:

```bash
firebase login --reauth
firebase apphosting:rollouts:create agent-playground --project video-clone-504ba --git-commit <reviewed-sha>
```

Use a specific reviewed commit for a manual rollout. App Hosting builds from
GitHub, not from the local working tree. An expired CLI login does not disable
the existing GitHub integration.

Verify it serves, and that runtime secrets resolved:

```bash
curl -s -X POST https://agent-playground--video-clone-504ba.asia-east1.hosted.app/api/token -H "Content-Type: application/json" -d '{"room_name":"smoke-test","participant_identity":"deploy-check"}'
```

A JSON response containing `server_url` and `participant_token` means the build,
the Secret Manager wiring, and the env vars are all healthy.

## Configuration

Build and runtime config live in [`apphosting.yaml`](../apphosting.yaml).

Public values (`NEXT_PUBLIC_LIVEKIT_URL`, `NEXT_PUBLIC_APP_CONFIG`) are baked
into the client bundle at build time. LiveKit credentials are **secrets**,
injected at runtime from Secret Manager and never exposed to the client:

```yaml
- variable: LIVEKIT_API_KEY
  secret: LIVEKIT_API_KEY
```

To set or rotate a secret:

```bash
firebase apphosting:secrets:set LIVEKIT_API_SECRET --project video-clone-504ba --data-file - --force
```

```bash
firebase apphosting:secrets:grantaccess LIVEKIT_API_KEY,LIVEKIT_API_SECRET --project video-clone-504ba --backend agent-playground
```

Secret names must match the `secret:` references in `apphosting.yaml`.

> **Never set credentials as plaintext env vars on the backend.** A backend-level
> `overrideEnv` supersedes `apphosting.yaml`, silently bypassing Secret Manager
> and leaving the values readable in cleartext by anyone with project read
> access.

## Build notes

App Hosting installs with **pnpm 11**, because `pnpm-lock.yaml` is committed.

pnpm 11 refuses to run dependency install scripts unless explicitly approved and
exits non-zero (`ERR_PNPM_IGNORED_BUILDS`). Approvals live in
[`pnpm-workspace.yaml`](../pnpm-workspace.yaml) under `allowBuilds` — `sharp`,
`esbuild`, and `unrs-resolver` all compile native binaries and need theirs.

Two gotchas if you touch dependencies:

- `onlyBuiltDependencies` in `package.json` **does not work**. pnpm 11 stopped
  reading the `pnpm` field from `package.json`, and replaced that setting with
  `allowBuilds` in `pnpm-workspace.yaml`.
- Adding a dependency with an install script will fail the build until you add it
  to `allowBuilds`.

Both `package-lock.json` and `pnpm-lock.yaml` are currently committed. The build
uses pnpm, so a passing `npm ci`/`npm run build` locally does **not** prove the
deploy will succeed. Reproduce with pnpm 11:

```bash
npx pnpm@11 install --frozen-lockfile && npx pnpm@11 run build
```

## Troubleshooting

**"Backend Not Found"** — the backend record exists but nothing is serving.
Usually one of:

- Billing disabled on the project. App Hosting requires the Blaze plan; when
  billing lapses, Cloud Run stops serving while `apphosting:backends:list` still
  reports a healthy-looking backend. Check with any Secret Manager call, which
  fails with an explicit billing error.
- No successful rollout yet — a newly created backend has no `managedResources`
  until its first build succeeds.

**Rollout fails with `- undefined`** — the App Hosting API returns only
`error: {code: 13}` with no message. The real error is in the Cloud Build log:

```bash
gcloud builds log <BUILD_ID> --region=asia-east1 --project=video-clone-504ba
```

The build ID is in the `buildLogsUri` printed by the failed rollout. Make sure
the console project selector reads `video-clone-504ba`.
