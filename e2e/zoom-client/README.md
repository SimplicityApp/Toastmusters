# Zoom-client test specs

Version-controlled test **instructions** for the things only the real Zoom client can show
(the SDK bridge, virtual backgrounds on real video, Zoom's own dialogs). They sit beside the
Playwright specs in `e2e/` and are maintained the same way: **a change that alters behaviour
updates its spec in the same PR.**

Who reads them: the `zoom-app-testing` skill (`.claude/skills/zoom-app-testing`). It reads
`INDEX.md`, picks the specs to run, and executes them. A human can follow the same steps.

## Layers: what proves what

| Layer | Lives in | Proves |
|---|---|---|
| Unit | `*.test.js` beside the code (vitest) | logic |
| Web e2e | `e2e/web.*.spec.js`, `e2e/zoom.*.spec.js` (Playwright) | UI in a plain browser, Zoom SDK mocked |
| Zoom client | `e2e/zoom-client/*.md` (these) | the real client: SDK bridge, real video, Zoom dialogs |

Do not write a Zoom-client step for something a lower layer already proves. If a step can be
a Playwright test, make it one and link it under `automated:`.

## Files

- `INDEX.md` — every spec, its status, last verified, what is not covered. Start here.
- `_template.md` — copy this for a new spec.
- `<feature>.md` — one spec per feature area.
- `docs/ZOOM_TEST_PLAN.md` stays as the Marketplace **reviewer-facing** plan. It is a subset
  written for Zoom's reviewers, not the source of truth for our own testing.

## Spec format

Front matter (flat `key: value`, lists as `- item`):

| Key | Meaning |
|---|---|
| `id` | short unique slug, same as the file name |
| `title` | human title |
| `status` | `current` (matches the code), `draft` (not yet run), `stale` (code moved on, needs review) |
| `covers` | list of source paths/dirs this spec describes. Drives staleness detection |
| `automated` | list of Playwright/vitest files that already cover part of it (may be empty) |
| `needs` | environment preconditions, e.g. `dev deployed`, `ENTITLEMENT_ENFORCE=1`, `camera on` |
| `verified_at` | git sha of the code when a human or the skill last ran it green, or `never` |
| `verified_on` | date of that run, or `never` |

Body: a one-paragraph **Purpose** (the failure this catches), then steps. Each step is:

```
### <ID> · auto|human · <what is checked>
Do: <action>
Expect: <observable result, with numbers>
Evidence: <how to prove it without reading pixels: request log, localStorage, KV, PostHog>
```

`auto` = the skill can act and verify. `human` = only the user may (sign-in, OAuth consent,
card entry, Stripe dashboard, sending messages, Wi-Fi). See the skill for the full list.
Step IDs are stable: never renumber, so run logs and bug reports keep pointing at them.

## Keeping it current

1. Behaviour change in a `covers` path → edit the spec's steps in the same PR.
2. `npm run test:specs` fails if a spec is malformed or a `covers` path no longer exists.
3. Two different staleness signals:
   - **Drift** (blocks a push): a `covers` file was committed *after* the spec itself was last
     edited, so nobody reviewed the doc against that code. `.githooks/pre-push` runs
     `check-zoom-specs.mjs --drift --review --stale`. For each drifted spec it runs `claude -p`
     on the code diff and the spec: "ok" (refactor, rename, untested area) passes, "update"
     blocks and names the step. Verdicts are cached in `.git/zoom-spec-reviews.json`. If the
     `claude` CLI is missing or not logged in, drift blocks as before. Fix it by reviewing the steps and committing the
     spec. Bypass once with `git push --no-verify`.
   - **Unverified** (warning): covered files changed since `verified_at`, meaning the spec
     was not rerun. `npm run test:specs -- --stale --strict` fails on it; use it before a release.
   The hook is enabled by `npm install` (`prepare` sets `core.hooksPath`). Fresh clone without
   it: `git config core.hooksPath .githooks`.
4. After a skill run, update `verified_at` / `verified_on` and `INDEX.md` to the sha and date
   it ran against. Mark failures `status: stale` rather than deleting steps.
5. Known gaps go in the spec's **Not covered** section, never silently dropped.
