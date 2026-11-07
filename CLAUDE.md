# Toastmusters Timer

Monorepo: Zoom app (`apps/zoom-app`), marketing + web app (`apps/web`), Table Topics
(`apps/table-topics`), shared code (`packages/shared`), API (`api`), Cloudflare Worker (`worker`).
Dev is the `dev` branch, production is `master`.

## Commands
- `npm test` — vitest across all projects
- `npm run test:e2e` — Playwright (`e2e/*.spec.js`, plain browser, Zoom SDK mocked)
- `npm run test:specs` — validate the Zoom-client specs (below)
- `npm run cf:deploy:dev` — build and deploy the dev Worker

## Tests: four layers, keep all of them current
| Layer | Where | Proves |
|---|---|---|
| Unit | `*.test.js` beside the code | logic |
| Web e2e | `e2e/*.spec.js` | UI in a plain browser |
| Zoom-client specs | `e2e/zoom-client/*.md` | the real Zoom client: SDK bridge, real video, Zoom dialogs |
| Reviewer plan | `docs/ZOOM_TEST_PLAN.md` | Marketplace reviewers only; a subset, not our source of truth |

**Rule: a change that alters user-visible behaviour updates its test in the same PR.** For
anything the real Zoom client shows, that means the matching spec in `e2e/zoom-client/`:

1. Find the spec whose `covers` list contains the file you changed (`INDEX.md` lists them all).
2. Edit its steps to match the new behaviour. Never renumber step IDs.
3. If no spec covers the area, add one from `_template.md` and list it in `INDEX.md`.
4. Run `npm run test:specs`. It fails on malformed specs and dangling `covers` paths.
5. Do not touch `verified_at` / `verified_on` unless you actually ran the spec. Those record a
   real run, not an edit. Running it is part of done (below); `status: stale` means a run was
   blocked, not skipped.

Read `e2e/zoom-client/README.md` for the spec format. To run the specs against the real Zoom
client, use the `zoom-app-testing` skill; it starts from `e2e/zoom-client/INDEX.md`.
`.githooks/pre-push` blocks a push when code a spec `covers` was committed after the spec was
last edited ("drift"). Review the spec against the change and commit it; don't bypass with
`--no-verify` to get around it. Before a release, run `npm run test:specs -- --stale --strict`
and rerun any spec it lists (changed since last real run).

## Definition of done
A change is done when all of these hold, not when the code compiles:
1. `npm test`, `npm run test:e2e` and `npm run test:specs` pass.
2. Every Zoom-client spec whose `covers` includes a changed file ran in the real Zoom client
   (`zoom-app-testing` skill) against this branch deployed to dev. Its `test-runs/<run>/run.md`
   shows each step ✅, or ⏭ for a `human` step with the reason. Run it yourself right after
   implementing; don't stop to ask whether to test.
3. The PR body follows `.github/pull_request_template.md` and links the run.

Stop short of step 2 only when blocked: the Mac is in use, Zoom wants a sign-in or app
authorization, or the deploy fails. Then set the spec's `status: stale`, write what blocked it
under "Not verified" in the PR, and label the PR `needs:zoom-test`.

## Standing approvals
Do these without asking when they are part of finishing a change:
- Deploy the current branch to dev (`npm run cf:deploy:dev`). Workers Builds restores `dev`
  on its next push.
- Start Zoom and a test meeting (`zoom-up.sh`) and drive the Zoom client for the specs.
- Flip `ENTITLEMENT_ENFORCE` / `FLAGS_FORCE` on dev for a spec's `needs`; restore them when
  the run ends.
- Create branches, commit, push a branch other than `dev`/`master`, open a draft PR, set the
  factory labels.

Before the first click in the Zoom client, say once in chat that you're taking the Mac and
wait 60 seconds (no wait if the user said they're away). If `click.sh` refuses because Zoom
isn't frontmost, the user is on the Mac: stop and wait for them.

Still ask before: merging, anything on `master` or production, deleting data, sending
messages, Stripe, and the skill's human-only list.

## Factory
Issues move through labels: `factory:ready` → `plan:review` → `plan:approved` →
`needs:zoom-test` → `ready-for-review`. `/factory <n>` runs the next station and stops at a
human gate. Read `.factory/README.md` before working on a `factory/` branch.

## Deploys (Cloudflare Workers Builds)
Only `toastmaster-timer` (master) and `toastmaster-timer-dev` (dev) are Git-connected.
Workers Builds forces every `wrangler deploy` in a build to that name, so never add a second
`wrangler deploy` to a build command. Table Topics is served from the timer Worker under
`/tabletopics`.

## Environments
Dev web `https://www.timer-dev.simple-tech.app`, Zoom host `zoom.timer-dev.simple-tech.app`.
`www.` is the website; the `zoom.` host routes every path to the sidebar app. On dev,
`ENTITLEMENT_ENFORCE` is `0` and `FLAGS_FORCE` is `"1"` by default. Facts and ids for test
runs live in `.claude/skills/zoom-app-testing/references/toastmusters.md`.

## Never
- Read `.env`.
- Leave `ENTITLEMENT_ENFORCE: "1"` set on dev after a test run without asking; it refuses sync
  for other dev testers.
