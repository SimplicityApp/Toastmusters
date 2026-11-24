---
id: club-pro-gate
title: Club features only while Pro is released
status: current
covers:
  - packages/shared/club.js
  - packages/shared/clubPresets.js
  - packages/shared/clubArchive.js
  - apps/zoom-app/src/hooks/useClub.js
  - apps/zoom-app/src/components/ReportTab.jsx
  - apps/zoom-app/src/hooks/useReportView.js
automated:
  - packages/shared/__tests__/club.test.js
  - apps/zoom-app/src/components/CardImagesModal.test.jsx
  - e2e/zoom.club-pro-gate.spec.js
needs:
  - dev deployed
  - FLAGS_FORCE "0" on dev (`pro` off) for GP-01 and GP-02; "1" for GP-03
  - the test Zoom account signed in and a member of an active club (Claude Test Club), with a
    club card set, club timings and the badge shown on cards; since #167 club Pro follows the
    account, so any computer signed in as that account is a "club device"
  - since plan 13, FLAGS_FORCE "1" also turns on `new_look` (design B); these steps are written for
    today's panel, so wherever they say "1", deploy "1,new_look=0" ("0" already has it off)
verified_at: 9d094d6
verified_on: 2026-11-24 (Zoom on macOS, factory/167 9d094d6: dev 52af75ee and 7c8ee168 with FLAGS_FORCE "0", fd826c9b with "1,new_look=0")
---

# Club features only while Pro is released

Every club feature reads one gate, `clubFeaturesOn` in `packages/shared/club.js`: the club
is active (the server says entitled) **and** the `pro` flag is known and on. While `pro` is
off, a club device behaves as a lapsed one: no badge, no club card set, no club timings, no
archive strip, History or End meeting & share, no club branding on reports, no renewal line.
Nothing is deleted. The account stays in its club and everything is back once `pro` is on.

## Purpose
Catches a club surface that still shows (or still uploads) while Pro is unreleased, and one
that does not come back when it is released, or comes back only after a reload.

## Steps

### GP-01 · auto · A club device shows no club features while `pro` is off
Do: with FLAGS_FORCE "0" on dev, open the app signed in as the club member account. Look at the Live tab
preview and your video, open Cards, open Edit timing rules, open the Report tab.
Expect: no club badge on the preview or on the video; Cards lists Classic, Modern and the
device's own sets but not "<club> cards", and the device's own set is the one in use; Edit
timing rules shows the device's own timings with no club banner or "Share with my club";
the Report tab has no "Saved to <club>" strip, no History and no End meeting & share; no
amber renewal line; the footer shows the locked Pro button.
Evidence: screenshots.

### GP-02 · auto · Nothing is sent to the club's archive while `pro` is off
Do: still with `pro` off, time a short speech and press FINISH.
Expect: the report lists it on this device, and no speech upload reaches the club
(`POST /api/club/meetings/…` absent from the Worker log).
Evidence: `reqs.sh` after FINISH.

### GP-03 · auto · Everything is back once `pro` is on
Do: set FLAGS_FORCE "1" on dev and refresh the app (⋯ → Refresh app).
Expect: the badge is back on the preview and the video where it was; Cards has "<club> cards"
selected again (unless the device chose its own); the club timings and banner are back;
the Report tab shows "Saved to <club>" with History. Nothing had to be re-entered.
Evidence: screenshots.

Run 2026-11-24 (factory/167 9d094d6): GP-01 and GP-02 passed with FLAGS_FORCE "0" (dev 52af75ee);
GP-03 passed in the second pass the same day (FLAGS_FORCE "0" → "1,new_look=0" and Refresh: badge back on the
preview and the video, the club's card set listed with the device's own choice kept). Log: test-runs/2026-11-24-167-zoom-pass-2/run.md.
Log: test-runs/2026-11-24-167-club-account-invites/run.md.
Run 2026-11-16 (claude/redesign-b-p3 7e05b9a with #145 merged locally): GP-01 and GP-02 passed with FLAGS_FORCE "0", GP-03 with
"1,new_look=0" (today's panel). Log: test-runs/2026-11-16-design-b-new-look-2/run.md.

## Not covered
- Reviewed against the #167 implementation: the gate is unchanged. The club copy is now applied
  only after the session has answered (for the same account), and GET /api/club still answers
  while `pro` is off, so GP-01's "nothing is deleted" and GP-03's return need no new step.
  Speech uploads carry the session, not `X-Club`.
- Reviewed against #167's verify fixes: a queued speech now carries its club id and is
  dropped unsent if the device is in another club by then; the logo warm-up waits for the club
  sync. Nothing the gate shows moves.
- The web app's copies (`apps/web`): same gate and shared code, covered by
  `apps/web/src/components/ReportTab.test.jsx`, `ClubStatusBanner.test.jsx` and
  `TimerApp.test.jsx`.
- A club that lapses while `pro` is on: [club-renewal-reminder](club-renewal-reminder.md) and
  the lapse steps in [club-card-sets](club-card-sets.md).
