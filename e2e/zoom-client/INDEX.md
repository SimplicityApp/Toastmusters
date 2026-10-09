# Zoom-client spec index

Read this first. Update it in the same PR as any spec change.

| Spec | Status | Verified | Covers |
|---|---|---|---|
| [timer-core](timer-core.md) | draft | never | start/colours/finish, resume after close |
| auth-identity | **not migrated** | — | source: `docs/ZOOM_TEST_PLAN.md` Steps 1, 1b, 1c |
| [contact-capture](contact-capture.md) | draft | never | Zoom email/name capture: authorize, "Stay in touch" card, browser and web sign-in doors, purge on uninstall (#83) |
| pro-club | **not migrated** | — | source: `docs/ZOOM_TEST_PLAN.md` P1–P7, plus the internal Club Pro plan (`06-zoom-client-test-plan-club-pro.md`); reference run `test-runs/2026-09-28-club-pro/run.md` |
| webhooks-lifecycle | **not migrated** | — | source: `docs/ZOOM_TEST_PLAN.md` Steps 4, 5, 6 |

"Not migrated" means the plan exists only in the reviewer-facing doc and has no spec here
yet. Migrate one at a time, running each once so `verified_at` is real.

## Run order for a full pass
Dependencies between specs, so the skill can batch human steps: `auth-identity` →
`contact-capture` → `timer-core` → `pro-club` → `webhooks-lifecycle` (deauth last, it removes the app).
