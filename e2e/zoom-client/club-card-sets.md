---
id: club-card-sets
title: Club card sets (share card artwork with the club)
status: draft
covers:
  - worker/club-cards.js
  - packages/shared/clubCards.js
  - packages/shared/cardImages.js
  - packages/shared/club.js
  - apps/zoom-app/src/components/CardImagesModal.jsx
  - apps/zoom-app/src/components/LiveTab.jsx
  - apps/zoom-app/src/main.jsx
automated:
  - worker/club-cards.test.js
  - packages/shared/__tests__/clubCards.test.js
  - apps/zoom-app/src/components/CardImagesModal.test.jsx
needs:
  - dev deployed
  - FLAGS_FORCE "1" on dev (the club doors are behind `pro`)
  - a dev club with a code, made with `node scripts/club-cli.mjs create --env dev`
  - Zoom account A, an admin or editor of that club (club-member record)
  - a second computer or browser profile, B, with no cards of its own
  - ENTITLEMENT_ENFORCE "1" on dev for CC-08 only (ask first; revert after)
verified_at: never
verified_on: never
---

# Club card sets (share card artwork with the club)

Phase 1 of `docs/plans/10-pro-is-the-club-plan.md`. An admin or editor publishes one of
their own custom card sets to the club; every device holding the club code downloads it
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
lists "Custom 1" as the club's set at the top. A's own selection does not change.
Evidence: `wrangler tail --env dev` shows two `PUT /api/club/cards/<hash>` → 200 and one
`PUT /api/club/cards` → 200. KV `club-cards:<clubId>` holds both hashes; `club:<clubId>.ver`
went up by 1. R2 has `club-card/<clubId>/<hash>` for each, and nothing under `club/<clubId>/`.

### CC-03 · human · B joins the club and gets the set
Do: on B (no cards of its own), open the app in Zoom and enter the club code (or open
`/pro/<CODE>` first). Start the timer in Timer + Camera mode with video on.
Expect: within a few seconds B's picker lists the club's set, selected. The blue card on B's
video is A's blue image; green and yellow are the Classic cards (the set skips them).
Evidence: tail shows `GET /api/club/cards/<hash>` → 200 from B, once per image. B's
localStorage has `toastmaster_club_cards`; `toastmaster_card_source` is absent (derived).

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
Do: on a device signed in as a club member (not editor or admin), open Card Images.
Expect: no **Share with my club** button on any custom set.
Evidence: a forced `PUT /api/club/cards` from that device returns 403.

### CC-07 · human · An admin removes the set from the console
Do: on the web, open `/club/admin` as the club admin. Under Card set, press **Remove card set**.
Expect: the section says there is no card set. On B's next app start, the club's set leaves
the picker and B shows Classic.
Evidence: tail shows `DELETE /api/club/cards` → 200; KV `club-cards:<clubId>` is gone and
`ver` went up by 1.

### CC-08 · human · A lapsed club stops showing its set
Do: with ENTITLEMENT_ENFORCE "1", republish a set from A, then set the club record to
`canceled` with `currentPeriodEnd` in the past. Reload B.
Expect: B shows its own choice (Classic) and the picker no longer lists the club's set. A's
**Share with my club** is gone. Revert the club record and ENTITLEMENT_ENFORCE afterwards.
Evidence: `GET /api/club` returns `entitled: false`; B's `toastmaster_club_cards` remains.

## Not covered
- Sharing from the web timer: same shared module and endpoints, proven by unit tests.
- Two publishers racing: the prune grace window and the client's retry are unit-tested.
- Card sets are one per club for now (open question 2 in the plan).
