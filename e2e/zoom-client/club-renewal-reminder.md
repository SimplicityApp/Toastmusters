---
id: club-renewal-reminder
title: Club renewal reminder (last 60 days of a club that will not renew)
status: stale
covers:
  - packages/shared/club.js
  - packages/ui/ClubGraceBanner.jsx
  - apps/zoom-app/src/components/ClubStatusBanner.jsx
automated:
  - packages/shared/__tests__/club.test.js
  - apps/zoom-app/src/components/ClubStatusBanner.test.jsx
needs:
  - dev deployed
  - a club device (Claude Test Club on the test Mac)
  - for CR-02 and CR-03, the club record's `currentPeriodEnd` / `status` edited in dev KV
    (save a backup first, restore after; ask the user once, as a list)
verified_at: never
verified_on: never
---

# Club renewal reminder (last 60 days of a club that will not renew)

The amber "<Club>'s Pro ends in N days" line above the tabs. It shows for a club that will
not renew (set to cancel at period end, or cancelled) only in its last 60 days, and only
when its end date is known. A failed payment is warned about at once, whatever the date.

## Purpose
Catches a reminder that nags a club months before anything is due (as on 2026-11-14:
"Pro ends in 316 days"), and one that stays silent when a club is about to lose Pro.

## Steps

### CR-01 · auto · No reminder with more than 60 days to go
Do: on a club device whose club is set not to renew and ends more than 60 days from now
(Claude Test Club on dev, 2026-11-14: `cancelAtPeriodEnd` true, about 316 days left), open
the app from Apps.
Expect: no amber renewal line above the tabs.
Evidence: screenshot; the device refresh (`GET /api/club`) returns `cancelAtPeriodEnd: true` and a
`currentPeriodEnd` more than 60 days out.

### CR-02 · auto · The reminder appears inside the last 60 days
Do: back up the club record, set its `currentPeriodEnd` to 30 days from now (dev KV), wait
about 60 s for the cache, then reopen the app.
Expect: "Claude Test Club's Pro ends in 30 days." with "Renew to keep your presets, branding
and archive." for an admin, or "Ask your club admin to renew." otherwise, and an ×. The ×
hides it for the rest of the day. Restore the record afterwards.
Evidence: screenshot; PostHog `club_grace_banner_shown` with `days_left: 30`.

### CR-03 · auto · A failed payment is warned about at once
Do: with the backup from CR-02, set the club's `status` to `past_due` and
`cancelAtPeriodEnd` to false, then reopen the app.
Expect: the amber line shows straight away ("Pro ends in N days" counting down a week from
the period end, or "payment did not go through" without a date). Restore the record
afterwards.
Evidence: screenshot.

## Not covered
- The web app's copy of the banner (`apps/web/src/components/ClubStatusBanner.jsx`). It
  reads the same `clubGraceReminder`, which the unit tests cover.
- Other club behaviour in `club.js` (joining, refresh, lapse, card sets). See
  [club-card-sets](club-card-sets.md); `pro-club` is not migrated yet.
