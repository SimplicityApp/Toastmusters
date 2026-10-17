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
   real run, not an edit. If you changed behaviour and did not rerun, set `status: stale`.

Read `e2e/zoom-client/README.md` for the spec format. To run the specs against the real Zoom
client, use the `zoom-app-testing` skill; it starts from `e2e/zoom-client/INDEX.md`.
`.githooks/pre-push` blocks a push when code a spec `covers` was committed after the spec was
last edited ("drift"). Review the spec against the change and commit it; don't bypass with
`--no-verify` to get around it. Before a release, run `npm run test:specs -- --stale --strict`
and rerun any spec it lists (changed since last real run).

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
