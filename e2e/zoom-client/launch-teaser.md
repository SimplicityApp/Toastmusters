---
id: launch-teaser
title: Pre-launch banner (a new look and Pro, coming soon)
status: draft
covers:
  - apps/zoom-app/src/components/LaunchTeaserBanner.jsx
  - apps/zoom-app/src/App.jsx
automated:
  - apps/zoom-app/src/components/LaunchTeaserBanner.test.jsx
  - e2e/zoom.launch-teaser.spec.js
needs:
  - dev deployed
  - FLAGS_FORCE "0" on dev (`pro` off) for LT-01 to LT-03; "1" for LT-04
verified_at: never
verified_on: never
---

# Pre-launch banner (a new look and Pro, coming soon)

A one-line heads-up above the tabs while Pro is unreleased: the app's new look and Pro are
on the way. It shows only while the `pro` flag is known and off, and a dismissal hides it
on that device for good.

## Purpose
Catches a banner that crowds the Zoom side panel (wraps badly or pushes the tabs off
screen at the panel's real width), a dismissal that does not survive closing the app, and
a banner that is still up after Pro launches.

## Steps

### LT-01 · auto · The banner shows above the tabs while `pro` is off
Do: with FLAGS_FORCE "0" on dev, open the app from Apps (on a device where the banner was
never dismissed: `localStorage.toastmaster_launch_teaser_dismissed` absent).
Expect: a light-blue line between Zoom's header and the Agenda / Live / Report tabs, with a
sparkle icon and "Coming soon: a fresh new look for the timer, and Pro features for your
club.", and an × at the right. At the panel's default width it wraps to two lines at most,
and the tabs and the timer below are still fully visible.
Evidence: screenshot; PostHog `launch_teaser_banner_shown` with `surface: "zoom"`.

### LT-02 · auto · The banner sits alongside the timer without getting in the way
Do: start a speech on the Live tab, let it reach green, then stop and reset.
Expect: the banner stays put, nothing jumps, and every Live tab control still works.
Evidence: screenshot at green.

### LT-03 · auto · Dismissed stays dismissed after reopening
Do: click the × on the banner. Close the app and reopen it from Apps.
Expect: the banner disappears at once and is not back after reopening.
Evidence: `localStorage.toastmaster_launch_teaser_dismissed` is `"1"`; PostHog
`launch_teaser_banner_dismissed`.

### LT-04 · auto · No banner once Pro is released
Do: remove `toastmaster_launch_teaser_dismissed` from localStorage, set FLAGS_FORCE "1" on
dev, and reopen the app.
Expect: no banner. The tabs sit directly under Zoom's header, as before this change.
Evidence: screenshot; `GET /api/me?flags=1` shows `"pro":true`.

## Not covered
- The web app (`apps/web`). The banner is only in the Zoom app, where the new look is
  coming.
- What replaces the banner at launch: the one-time Pro announcement, which is on its own
  branch (`feat/pro-launch-announcement`) with its own spec.
