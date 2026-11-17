---
id: club-history
title: Club history meeting view shows the meeting's own day
status: stale
covers:
  - packages/ui/BrandedReportHeader.jsx
  - packages/ui/ReportHistoryList.jsx
automated:
  - packages/ui/BrandedReportHeader.test.jsx
needs:
  - dev deployed
  - FLAGS_FORCE "1" on dev (`pro` on; `wrangler.jsonc` ships dev with "0", which hides History),
    e.g. `wrangler deploy --env dev --var FLAGS_FORCE:1` after the build; restore after the run
  - a club device whose club is active and shows its branding on reports (Claude Test Club on
    the test Mac), with at least one meeting in the club's History
  - the Mac's time zone west of UTC (`date +%Z`; the test Mac is EST), which is where the
    meeting's header used to say the day before
verified_at: never
verified_on: never
---

# Club history meeting view shows the meeting's own day

A club meeting's date reaches the report header as a bare `YYYY-MM-DD`. The header used to
pass it to `new Date()`, which reads a bare date as UTC midnight, so west of UTC the opened
meeting's header said the day before the meeting: on 2026-11-16 (EST) the History list said
"Mon, Nov 16, 2026" for meeting 20261116 and the opened meeting said "Sun, Nov 15, 2026".
`BrandedReportHeader` now reads a bare date at local noon, as the History list already did.

## Purpose
Catches a club report header that prints a different day from the History row it was opened
from, in the real Zoom webview and the Mac's own time zone.

## Steps

### CH-01 · auto · An opened meeting's header shows the same day as its History row
Do: on the club device, open the Report tab → History. Note the date on a meeting's row
(e.g. meeting 20261116, "Mon, Nov 16, 2026") and open that meeting.
Expect: the header under the club name reads "Timing report · <the row's date>", e.g.
"Timing report · Mon, Nov 16, 2026" for 20261116, and not the day before.
Evidence: screenshots of the row and of the opened meeting's header; `date +%Z` on the Mac
showing a zone west of UTC.

### CH-02 · auto · The device's own report header still shows today
Do: close History. With at least one report on the device (time a short speech and press
FINISH if there is none), look at the header above the Report tab's table.
Expect: "Timing report · <today's date on the Mac>".
Evidence: screenshot; `date` on the Mac.

## Not covered
- Zones east of UTC, and the full set of inputs (Date, timestamp, ISO date-time, no date, an
  unreadable date): `packages/ui/BrandedReportHeader.test.jsx` runs the header in seven zones
  from UTC−10 to UTC+14. Changing the Mac's time zone to repeat CH-01 elsewhere is a system
  setting and is not done here.
- The web app's meeting view (`apps/web/src/components/ReportTab.jsx`) and design B's
  `ReportTabB.jsx` render the same `BrandedReportHeader`; the unit test covers them.
- The shared report image's date (`packages/shared/reportImage.js`, `readableReportDate`):
  separate code that already read bare dates at noon.
- The rest of the club's archive (strip, End meeting & share, share links): `pro-club`, not
  migrated yet.
