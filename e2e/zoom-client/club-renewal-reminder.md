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
  - FLAGS_FORCE "1" on dev (`pro` on) for CR-01 to CR-03; "0" for CR-04
  - a club device (Claude Test Club on the test Mac)
  - for CR-02 and CR-03, the club record's `currentPeriodEnd` / `status` edited in dev KV
    (save a backup first, restore after; ask the user once, as a list). Since #167 the app
    re-reads its club on every open once the Zoom session exists (no 24 h cache), so closing
    and reopening the timer in Zoom is the refresh; no localStorage edit is needed
  - since plan 13, FLAGS_FORCE "1" also turns on `new_look` (design B); these steps are written for
    today's panel, so wherever they say "1", deploy "1,new_look=0" ("0" already has it off)
verified_at: 51534f9
verified_on: 2026-11-14 (CR-01 in Zoom 7.2.5 on 4d95d3d; CR-02/CR-03 on the web app as a second club device, dev dd1b9ab7 restore)
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
Do: back up the club record, set its `currentPeriodEnd` to 29.5 days from now (dev KV), wait
about 60 s for the KV cache, then close and reopen the timer in Zoom.
Expect: "Claude Test Club's Pro ends in 30 days." with "Renew to keep your presets, branding
and archive." for an admin, or "Ask your club admin to renew." otherwise, and an ×. The ×
hides it for the rest of the day. Restore the record afterwards.
Evidence: screenshot; PostHog `club_grace_banner_shown` with `days_left: 30`.

### CR-03 · auto · A failed payment is warned about at once
Do: with the backup from CR-02, set the club's `status` to `past_due`, `cancelAtPeriodEnd`
to false and `currentPeriodEnd` to 2 days ago, then close and reopen the timer in Zoom.
Expect: the amber line shows straight away ("Pro ends in N days" counting down a week from
the period end, or "payment did not go through" without a date). Restore the record
afterwards.
Evidence: screenshot.

### CR-04 · auto · No reminder at all while `pro` is off
Do: with FLAGS_FORCE "0" on dev, open the app on a club device whose club is inside the
60-day window or has a failed payment (the CR-02 or CR-03 state).
Expect: no amber renewal line. Club features are off until Pro is released (see
[club-pro-gate](club-pro-gate.md)).
Evidence: screenshot.

## Not covered
- Reviewed against the #167 implementation: the club is re-read on every open once the
  session exists (`syncClubWithIdentity` → `GET /api/club`), which is what CR-02/CR-03's
  close-and-reopen relies on. The reminder's own logic is unchanged.
- CR-02 and CR-03 ran 2026-11-14 on the web app as a second club device, because the Zoom
  client then re-read its club only once a day. Since #167 they run in Zoom (reopen the timer);
  not rerun yet.
- Other club behaviour in `club.js` (joining, refresh, lapse, card sets). See
  [club-membership](club-membership.md) and [club-card-sets](club-card-sets.md).
