# Toastmusters project facts for test runs

Verify anything here against the repo before relying on it — ids and hosts change.

## Environments
| | Dev | Prod |
|---|---|---|
| Worker | `toastmaster-timer-dev` (`wrangler … --env dev`) | `toastmaster-timer` |
| Web origin (`WEB_ORIGIN`) | `https://www.timer-dev.simple-tech.app` | `https://www.timer.simple-tech.app` |
| Zoom sidebar host | `zoom.timer-dev.<domain>` | `zoom.timer.<domain>` |
| Zoom app client id | `kgpoX2A6TY2BvdctzK9iw` | `DsFHK5sNQs2_VFyeQky2sg` |
| KV `PROFILES` | `4e1f8e3bbef340ee9d7a5d14fbdeeb26` | see `wrangler.jsonc` top level |

Domains: both `simple-tech.app` and `toastmusters.com` hosts are attached; `www.` is the
website, `zoom.` routes every path to the sidebar app (so never open the console on `zoom.`).

Deploy dev: `npm run cf:deploy:dev` (build + `wrangler deploy --env dev`).

## Entitlement gate
`env.dev.vars.ENTITLEMENT_ENFORCE`: `"0"` = server treats everyone as entitled (dev default;
the UI still shows plans). `"1"` = production behaviour; needed to test 402/403 refusals and
club lapse. Flip only with the user's OK, and revert + redeploy at the end — while `"1"`, other
dev testers without Pro are refused sync.

## Club tooling
- `node scripts/club-cli.mjs pending|create|show|rotate --env dev …` (`create` also takes
  `--customer cus_…` to link Stripe).
- Useful keys: `club:<id>`, `club-by-code:<CODE>`, `club-member:<id>:zoom:<uid>`,
  `club-device:<id>:<deviceId>`, `club-pending:<cus>`.
- Device state lives in `localStorage`: `toastmaster_club` (token, ver, plan, role…),
  `toastmaster_club_presets`, `toastmaster_club_outbox` (speeches not yet uploaded).
- The admin console only recognises a Zoom sign-in in a browser that has also activated the
  club code (open `/pro/<CODE>` first) — see `docs/plans/08-club-pro-bugfix-plan.md` #1.

## Test plans and past runs
- `docs/ZOOM_TEST_PLAN.md` — reviewer-facing steps (1, 1b, 1c, 2, 3, 3b, P1–P7).
- `.humanlayer/tasks/define-pro-features-plan-with-code-call-stacks-6t488q/06-zoom-client-test-plan-club-pro.md` — deep Club Pro plan.
- `test-runs/2026-09-28-club-pro/run.md` — the reference run this skill was built from.
