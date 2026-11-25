---
id: club-card-sets
title: Club card sets (share card artwork with the club)
status: stale
covers:
  - worker/club-cards.js
  - packages/shared/clubCards.js
  - packages/shared/cardImages.js
  - packages/shared/club.js
  - apps/zoom-app/src/components/CardImagesModal.jsx
  - apps/zoom-app/src/components/CardSetsPanel.jsx
  - apps/zoom-app/src/components/LiveTab.jsx
  - apps/zoom-app/src/hooks/useLiveTimer.js
  - apps/zoom-app/src/main.jsx
automated:
  - worker/club-cards.test.js
  - packages/shared/__tests__/clubCards.test.js
  - apps/zoom-app/src/components/CardImagesModal.test.jsx
needs:
  - dev deployed
  - FLAGS_FORCE "1" on dev (the club doors are behind `pro`, and since 2026-11-14 every club
    feature is too: with `pro` off the club set is not listed; see club-pro-gate)
  - a dev club with a code, made with `node scripts/club-cli.mjs create --env dev`
  - Zoom account A, an admin or editor of that club (club-member record)
  - Zoom account B, a second Zoom account that is a member of the club (since #167 a club
    belongs to accounts, not devices), signed in on a second computer or in the web app in a
    browser profile, with no cards of its own; without a second account, CC-03 and the steps
    that use B are ⏭ with the reason
  - ENTITLEMENT_ENFORCE "1" on dev for CC-08 only (ask first; revert after)
  - since plan 13, FLAGS_FORCE "1" also turns on `new_look` (design B); these steps are written for
    today's panel, so wherever they say "1", deploy "1,new_look=0" ("0" already has it off)
verified_at: 905d8d1
verified_on: 2026-11-13 (Zoom 7.2.5, macOS 26.7.2, dev 3ce801a6)
---

# Club card sets (share card artwork with the club)

Phase 1 of `docs/plans/10-pro-is-the-club-plan.md`. An admin or editor publishes one of
their own custom card sets to the club; every account in the club downloads it
and shows it on real video. Unit tests prove the server checks, the switch logic and the
download. Only the real client proves that a club image pushed through the SDK bridge
looks the same as a personal one, and that the image arrives on a second machine.

## Purpose
Catches a published set that never reaches another club device, a club card that shows on
the stage but not on the virtual background, a device whose own chosen cards are silently
replaced by the club's, and a lapsed or left club whose cards keep showing.

## Steps

### CC-01 · auto · A, the publisher, adds a custom set
Do: on A in Zoom, open the timer, Card Images, upload one image each for blue and red, Add set.
Expect: "Custom 1" appears selected. The row shows **Share with my club** (A is admin or editor).
Evidence: localStorage `toastmaster_custom_card_images` lists `custom-1` with `["blue","red"]`.

### CC-02 · auto · A shares the set
Do: on A, press **Share with my club** on Custom 1.
Expect: toast "Shared with <club>. Every club device gets these cards." A's picker now also
lists "<club> cards" (e.g. "Claude Test Club cards") as the club's set at the top, not
"Custom 1". A's own selection does not change.
Evidence: `wrangler tail --env dev` shows two `PUT /api/club/cards/<hash>` → 200 and one
`PUT /api/club/cards` → 200. KV `club-cards:<clubId>` holds both hashes; `club:<clubId>.ver`
went up by 1. R2 has `club-card/<clubId>/<hash>` for each, and nothing under `club/<clubId>/`.

### CC-03 · human · B joins the club and gets the set
Do: on B (no cards of its own), signed in to Zoom as account B with the app approved, open the
app in Zoom and enter the club code (or open `/pro/<CODE>` on the web signed in as B; it then
needs no code in Zoom). Start the timer in Timer + Camera mode with video on.
Expect: within a few seconds B's picker lists the club's set, selected. The blue card on B's
video is A's blue image; green and yellow are the Classic cards (the set skips them).
Evidence: tail shows `GET /api/club/cards/<hash>` → 200 from B, once per image, with B's
session and no `x-club` header. B's localStorage has `toastmaster_club_cards`;
`toastmaster_card_source` is absent (derived).

### CC-04 · auto · The club card reaches red on real video
Do: on B, run a speech past red.
Expect: the red card on B's video is A's red image, the same framing as a personal custom
card. Switching blue → green → yellow → red stays smooth (no visible decode stall).
Evidence: screenshot of B's self-view at red.

### CC-05 · auto · A device with its own cards keeps them
Do: on a device that had picked Modern before joining, open Card Images.
Expect: Modern stays selected; the club's set is listed above it but not selected. Choosing
the club's set shows it; choosing Modern again goes back.
Evidence: `toastmaster_card_source` is `club`, then `own`.

### CC-06 · auto · Members cannot publish
Do: as account B, a club member (not editor or admin), open Card Images.
Expect: no **Share with my club** button on any custom set.
Evidence: a forced `PUT /api/club/cards` with B's session returns 403. The same request with no
session at all returns 401 before the role check (there are no guest club devices any more).

### CC-07 · human · An admin removes the set from the console
Do: on the web, open `/club/admin` as the club admin. Under Card set, press **Remove card set**.
Expect: the section says there is no card set. The next time B opens the timer, the club's set
leaves the picker and B shows its own choice (Classic on a device that never chose). Since #167
the club is re-read on every open once the session exists (no 24 h wait), so closing and
reopening the app as B is enough.
Evidence: tail shows `DELETE /api/club/cards` → 200; KV `club-cards:<clubId>` is gone and
`ver` went up by 1.

### CC-08 · human · A lapsed club stops showing its set
Do: with ENTITLEMENT_ENFORCE "1", republish a set from A, then set the club record to
`canceled` with `currentPeriodEnd` in the past. Close and reopen the app as B.
Expect: B shows its own choice (Classic) and the picker no longer lists the club's set. A's
**Share with my club** is gone. Revert the club record and ENTITLEMENT_ENFORCE afterwards.
Evidence: `GET /api/club` returns `entitled: false`; B's `toastmaster_club_cards` remains.

### CC-09 · auto · A republishes; the old image is pruned
Do: on A, add a second custom set and press **Share with my club** on it, at least 15 minutes
after the first share.
Expect: the club row at the top of A's picker shows the new set. B keeps the previous set until
it next opens the timer (see CC-07).
Evidence: `PUT /api/club/cards` → 200; KV `club-cards:<clubId>` names only the new hashes and
`ver` went up by 1; `GET /api/club/cards/<old hash>` with B's session → 404 (pruned).

Run 2026-11-24 (factory/167 9d094d6, dev fd826c9b with FLAGS_FORCE "1,new_look=0", then c5175c33 with "1" for
CC-09 in the new look's Cards sheet, which has the same Share rows): CC-01, CC-02, CC-05 (on A's device) and
CC-09 passed — the republish pruned both old images (404) and the club set was then re-shared from Custom 1, so
Claude Test Club keeps its CLUB BLUE / CLUB RED set. CC-03, CC-04, CC-06, CC-07 and CC-08 need account B and
were not run. Use fresh images: re-uploading the fixtures already in the club set hashes the same. Log: test-runs/2026-11-24-167-zoom-pass-2/run.md.

## Not covered
- Reviewed against the #167 implementation: card downloads and publishes carry the session
  (Bearer in Zoom, the cookie on the web) and wait for it, and the club comes from the account,
  as CC-03, CC-06 and CC-07 now say. No step moves.
- Reviewed against #167's verify fixes: the card-set sync now starts once the club sync after
  the session has settled (not at module load), and a copy of another club is forgotten before
  the new club's set lands. CC-03's evidence (B's downloads carry B's session) is unchanged.
- Joining, leaving and removal themselves (#167): see [club-membership](club-membership.md).
- Sharing from the web timer: same shared module and endpoints, proven by unit tests.
- Two publishers racing: the prune grace window and the client's retry are unit-tested.
- Card sets are one per club for now (open question 2 in the plan).
- The club set while `pro` is off (`clubFeaturesOn` in `club.js`, used by `cardImages.js`,
  `clubCards.js` and `CardImagesModal.jsx`): it is not listed and the device shows its own
  cards. See [club-pro-gate](club-pro-gate.md).
- The renewal reminder's 60-day window (`clubGraceReminder` in `club.js`, PR #147). Reviewed
  2026-11-14: it changes when the amber renewal line shows, not card sets; see
  [club-renewal-reminder](club-renewal-reminder.md). Not rerun for it.
- The Live tab refusing an agenda row that needs a role (#91, `LiveTab.jsx`). Reviewed
  2026-11-13: it changes which speaker loads, not the card artwork or its push; no step here
  loads an agenda row. See [timer-core](timer-core.md) TC-13.

Run 2026-11-13 (dev tip 905d8d1, dev 3ce801a6, A = Zoom desktop, B = web app in a browser
profile): CC-01…CC-05 and CC-09 passed; CC-02 now labels the set "<club> cards" (null label in
KV). CC-06 only from B, a guest with no Zoom session: 401, not the member 403. CC-07 (console
sign-in) and CC-08 (lapsing the club) not run. Log: test-runs/2026-11-13-pre-master-specs/run.md.

Run 2026-11-16 (claude/redesign-b-p3 7e05b9a with #145 merged locally; FLAGS_FORCE "1,new_look=0", A = Zoom desktop): CC-05
passed. CC-01 added and selected "Custom 1" but showed no **Share with my club**: A's cached
club role was null although its member row says admin. Its last refresh went out before the
Zoom session existed (`refreshClub` at module load in `main.jsx`), so the server could not
name the caller; tracked separately. CC-02 and CC-09 blocked by that; the set was deleted
again. CC-03, CC-04, CC-06 to CC-08 need B, a member device or the console and were not run;
CC-10 passed on #145's run the same day. Log: test-runs/2026-11-16-design-b-new-look-2/run.md.

Not run 2026-11-19 (claude/redesign-b-p3 61de1d8 with dev c42fbbf merged locally (83fc093, not pushed)): the test device was no longer in Claude Test Club. The daily run
earlier that day saw GET /api/club → 401 and POST /api/club/leave at start-up (the club token
was past 24 h; `refreshClub` calls `leaveClub()` on a 401), and the app offers a personal-Pro
device no code field to rejoin. Rerun once the device is back in the club (or after #167).
Log: test-runs/2026-11-19-design-b-stack-final/run.md.
