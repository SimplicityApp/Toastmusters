# Zoom-client spec index

Read this first. Update it in the same PR as any spec change.

| Spec | Status | Verified | Covers |
|---|---|---|---|
| [timer-core](timer-core.md) | current | 905d8d1, 2026-11-13 | start/colours/finish, resume after close; `audience_size` on `timer_started` for hosts, omitted for non-hosts (#107); the Live tab's suggestions, stage picker and FINISH refuse an agenda row that needs a role (#91 follow-up). TC-09 and TC-12 (human) not run |
| [agenda-import](agenda-import.md) | current | b029a29, 2026-11-13 | Simple Format import takes exact role names from the bracket text and highlights the rest for a manual pick; imported and picked roles' thresholds on real video (#77, #91) |
| [zoom-deeplink](zoom-deeplink.md) | draft | never | "Open in Zoom" deeplink resolves and launches this build's app (dev vs production client id) |
| auth-identity | **not migrated** | — | source: `docs/ZOOM_TEST_PLAN.md` Steps 1, 1b |
| [connection-notice](connection-notice.md) | draft | never | guest-mode banner and "Approve Toastmusters Timer in Zoom" modal at open; raised mid-session when Zoom drops the grant, modal held until the timer stops (#85) |
| [reauth-landing](reauth-landing.md) | stale | never | install landing: `tt_approved` mark, `?welcome=new` / `?welcome=back`, "You're reconnected" and Open in Zoom; a marked browser's bare `/` redirects to `/reconnect` (`/?home` and the `zoom.` host do not); where Zoom lands a guest after approving (#96) |
| [contact-capture](contact-capture.md) | draft | never | Zoom email/name capture: authorize, "Stay in touch" card, browser and web sign-in doors, purge on uninstall (#83) |
| [timer-sounds](timer-sounds.md) | draft | never | Pro sounds: card-change chime (1/2/3 notes), break music during Take a Break, locked for free plans, audible through Share sound (#105) |
| [pro-launch](pro-launch.md) | current | eeaa840, 2026-11-13 | one-time "New: Pro for your club" window after FINISH for free devices once `pro` is on; hand-off to the Upgrade dialog; red dot on the footer's Upgrade button until Pro has been looked at. PL-01's free-device half and PL-04 (Free account) not run yet |
| [club-card-sets](club-card-sets.md) | current | 905d8d1, 2026-11-13 | an admin or editor shares a custom card set with the club; another club device downloads it and shows it on real video; own choice kept; members can't publish; console removal; lapse; republish prunes the old image (plan 10 Phase 1). CC-07 and CC-08 not run on 905d8d1, and CC-06's member 403 never yet (a guest got 401) |
| pro-club | **not migrated** | — | source: `docs/ZOOM_TEST_PLAN.md` P1–P7, plus the internal Club Pro plan (`06-zoom-client-test-plan-club-pro.md`); reference run `test-runs/2026-09-28-club-pro/run.md` |
| webhooks-lifecycle | **not migrated** | — | source: `docs/ZOOM_TEST_PLAN.md` Steps 4, 5, 6 |

"Not migrated" means the plan exists only in the reviewer-facing doc and has no spec here
yet. Migrate one at a time, running each once so `verified_at` is real.

## Run order for a full pass
Dependencies between specs, so the skill can batch human steps: `auth-identity` →
`connection-notice` → `reauth-landing` → `contact-capture` → `timer-core` → `timer-sounds` → `agenda-import` → `pro-launch` → `pro-club` → `club-card-sets` → `webhooks-lifecycle` (deauth
last, it removes the app).
