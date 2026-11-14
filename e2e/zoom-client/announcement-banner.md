---
id: announcement-banner
title: Announcement banner (currently the pre-launch notice)
status: current
covers:
  - packages/shared/announcements.js
  - packages/ui/AnnouncementBanner.jsx
  - apps/zoom-app/src/components/AnnouncementBanner.jsx
  - apps/zoom-app/src/App.jsx
automated:
  - packages/shared/__tests__/announcements.test.js
  - apps/zoom-app/src/components/AnnouncementBanner.test.jsx
  - e2e/zoom.announcement-banner.spec.js
needs:
  - dev deployed
  - FLAGS_FORCE "1" on dev (`pro` on) for AB-01; "0" (`pro` off) for AB-02 to AB-04
verified_at: cb49176
verified_on: 2026-11-14 (Zoom 7.2.5, macOS 26.7.2, dev b5efb7d2 and fcf1ed01)
---

# Announcement banner (currently the pre-launch notice)

A one-line notice above the tabs, picked from `ANNOUNCEMENTS` in
`packages/shared/announcements.js`: the first entry that applies to the Zoom app, has not
been closed on this device, is inside its dates and passes its flag condition. Today the
list holds one entry, `pre-launch-2026-11`: "Coming soon: a fresh new look for the timer,
and Pro features for your club.", shown only while `pro` is off.

Adding or changing an entry changes `announcements.js`, which this spec covers. Rerun
AB-02 to AB-04 with the new entry's text and id, so its wording is seen at the panel's
real width.

## Purpose
Catches a notice that crowds the Zoom side panel (wraps badly or pushes the tabs off screen
at the panel's real width), a close that does not survive reopening the app, and a notice
still up after its condition has ended.

## Steps

### AB-01 · auto · No pre-launch notice once Pro is released
Do: with FLAGS_FORCE "1" on dev, open the app from Apps. Run this before AB-04, whose close
also hides the notice.
Expect: no announcement banner. The tabs sit directly under Zoom's header (or under the club
renewal banner, on a club device whose Pro is ending).
Evidence: screenshot; the footer shows the Pro chip, which proves `pro` reached the app.

### AB-02 · auto · The current announcement shows above the tabs
Do: with FLAGS_FORCE "0" on dev, open the app from Apps on a device where it was never
closed (`localStorage.toastmaster_announcements_dismissed` absent or without its id).
Expect: a light-blue line between Zoom's header and the Agenda / Live / Report tabs, with a
sparkle icon, the bold lead and the text ("Coming soon: a fresh new look for the timer, and
Pro features for your club."), and an × at the right. At the panel's default width it wraps
to two lines at most, and the tabs and timer below are fully visible.
Evidence: screenshot; PostHog `announcement_shown` with `announcement_id`.

### AB-03 · auto · The banner sits alongside the timer without getting in the way
Do: start a speech on the Live tab, let it reach green, then stop and reset.
Expect: the banner stays put, nothing jumps, and every Live tab control still works.
Evidence: screenshot at green.

### AB-04 · auto · A closed announcement stays closed after reopening
Do: click the × on the banner. Close the app (Apps → Close all) and reopen it from Apps.
Expect: the banner disappears at once and is not back after reopening.
Evidence: `localStorage.toastmaster_announcements_dismissed` holds its id; PostHog
`announcement_dismissed`.

## Not covered
- The web app (`apps/web`). The shared banner and the list support `surfaces: ['web']`, but
  only the Zoom app renders it so far.
- An announcement's `link`, `starts` / `ends` and `tone`. The list has no entry using them
  yet; unit and e2e tests cover them. Run AB-02 against the first entry that does.
- What replaces the pre-launch notice at launch: the one-time Pro announcement, on its own
  branch (`feat/pro-launch-announcement`) with its own spec.
- Design B's panel (`new_look` on, plan 13). App.jsx now picks between today's panel and
  NewLookShell; until design B's own shell lands, NewLookShell is today's panel, so these
  steps hold either way. Run them with `new_look` off (`FLAGS_FORCE "1,new_look=0"` or
  `"0"`); design B's banner placement gets its own steps with its shell.
