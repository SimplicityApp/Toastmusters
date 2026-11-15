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
  - a club device whose club is active (Claude Test Club on the test Mac), with a club card
    set, club timings and the badge shown on cards
  - since plan 13, FLAGS_FORCE "1" also turns on `new_look` (design B); these steps are written for
    today's panel, so wherever they say "1", deploy "1,new_look=0" ("0" already has it off)
verified_at: 32ebeb7
verified_on: 2026-11-14 (Zoom 7.2.5, macOS 26.7.2, dev with FLAGS_FORCE "0" then "1")
---

# Club features only while Pro is released

Every club feature reads one gate, `clubFeaturesOn` in `packages/shared/club.js`: the club
is active (the server says entitled) **and** the `pro` flag is known and on. While `pro` is
off, a club device behaves as a lapsed one: no badge, no club card set, no club timings, no
archive strip, History or End meeting & share, no club branding on reports, no renewal line.
Nothing is deleted. The device stays in its club and everything is back once `pro` is on.

## Purpose
Catches a club surface that still shows (or still uploads) while Pro is unreleased, and one
that does not come back when it is released, or comes back only after a reload.

## Steps

### GP-01 · auto · A club device shows no club features while `pro` is off
Do: with FLAGS_FORCE "0" on dev, open the app on the club device. Look at the Live tab
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

## Not covered
- The web app's copies (`apps/web`): same gate and shared code, covered by
  `apps/web/src/components/ReportTab.test.jsx`, `ClubStatusBanner.test.jsx` and
  `TimerApp.test.jsx`.
- A club that lapses while `pro` is on: [club-renewal-reminder](club-renewal-reminder.md) and
  the lapse steps in [club-card-sets](club-card-sets.md).
