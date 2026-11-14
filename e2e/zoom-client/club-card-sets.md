---
id: club-card-sets
title: Club card sets (share card artwork with the club)
status: stale
covers:
  - worker/club-cards.js
  - worker/club.js
  - worker/club-token.js
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
  - worker/club.test.js
  - worker/club-token.test.js
  - packages/shared/__tests__/club.test.js
needs:
  - dev deployed
  - FLAGS_FORCE "1" on dev (the club doors are behind `pro`)
  - a dev club with a code, made with `node scripts/club-cli.mjs create --env dev`
  - Zoom account A, an admin or editor of that club (club-member record)
  - a second computer or browser profile, B, with no cards of its own
  - ENTITLEMENT_ENFORCE "1" on dev for CC-08 only (ask first; revert after)
verified_at: 905d8d1
verified_on: 2026-11-13 (Zoom 7.2.5, macOS 26.7.2, dev 3ce801a6)
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
replaced by the club's, a lapsed or left club whose cards keep showing, and a club device that
drops out of the club (and its cards) the first time it opens more than a day after its last
refresh.

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
Evidence: a forced `PUT /api/club/cards` from that device returns 403. From a guest club device
with no Zoom session (the web app as B), the same request returns 401 before the role check.

### CC-07 · human · An admin removes the set from the console
Do: on the web, open `/club/admin` as the club admin. Under Card set, press **Remove card set**.
Expect: the section says there is no card set. On B's next club refresh, the club's set leaves
the picker and B shows its own choice (Classic on a device that never chose). A club refresh runs at app start only when the last one is
over 24 h old (`CLUB_REFRESH_INTERVAL_MS`); to see it now, set `lastRefreshAt` to 0 in B's
`toastmaster_club` and reload.
Evidence: tail shows `DELETE /api/club/cards` → 200; KV `club-cards:<clubId>` is gone and
`ver` went up by 1.

### CC-08 · human · A lapsed club stops showing its set
Do: with ENTITLEMENT_ENFORCE "1", republish a set from A, then set the club record to
`canceled` with `currentPeriodEnd` in the past. Force B's refresh (`lastRefreshAt` 0) and reload.
Expect: B shows its own choice (Classic) and the picker no longer lists the club's set. A's
**Share with my club** is gone. Revert the club record and ENTITLEMENT_ENFORCE afterwards.
Evidence: `GET /api/club` returns `entitled: false`; B's `toastmaster_club_cards` remains.

### CC-09 · auto · A republishes; the old image is pruned
Do: on A, add a second custom set and press **Share with my club** on it, at least 15 minutes
after the first share.
Expect: the club row at the top of A's picker shows the new set. Another club device keeps the
previous set until its next club refresh (see CC-07).
Evidence: `PUT /api/club/cards` → 200; KV `club-cards:<clubId>` names only the new hashes and
`ver` went up by 1; `GET /api/club/cards/<old hash>` with a club token → 404 (pruned).

### CC-10 · auto · A device a day or more past its last refresh stays in the club
Do: open the app on a club device whose last club refresh is over 24 h old, so its club token
(24 h) has expired. In Zoom (A): open the timer more than 24 h after A's last
`GET /api/club` (`lastRefreshAt` in `toastmaster_club`). On B (web), without waiting a day: put
one of B's own earlier club tokens (minted over 24 h ago, for example from an older run's
`tail.jsonl`) back in `toastmaster_club.clubToken`, set `lastRefreshAt` to its `iat`, and
reload `/timer/app`.
Expect: the device stays in the club. The Pro banner and the club badge stay, the plan stays
Pro, and the club's set is still in the picker (selected where it was). Before the fix this
refresh answered 401 and the device left the club.
Evidence: `GET /api/club` → 200 and no `POST /api/club/leave`. `toastmaster_club.clubToken` is
replaced by a new token for the same `deviceId` whose payload has `iat` ≈ now and
`exp` = `iat` + 24 h; `lastRefreshAt` ≈ now. The same expired token replayed with curl (`X-Club`)
→ 200; with one character of the signature changed → 401. A token more than 180 days past its
`exp` (`CLUB_TOKEN_REFRESH_GRACE_MS`) → 401, unit-tested only (worker/club.test.js).

## Not covered
- Sharing from the web timer: same shared module and endpoints, proven by unit tests.
- Two publishers racing: the prune grace window and the client's retry are unit-tested.
- Card sets are one per club for now (open question 2 in the plan).
- The Live tab refusing an agenda row that needs a role (#91, `LiveTab.jsx`). Reviewed
  2026-11-13: it changes which speaker loads, not the card artwork or its push; no step here
  loads an agenda row. See [timer-core](timer-core.md) TC-13.
- A revoked device, or one that left, refused by the refresh even with an expired token:
  unit-tested (worker/club.test.js), not run here.

Run 2026-11-13 (dev tip 905d8d1, dev 3ce801a6, A = Zoom desktop, B = web app in a browser
profile): CC-01…CC-05 and CC-09 passed; CC-02 now labels the set "<club> cards" (null label in
KV). CC-06 only from B, a guest with no Zoom session: 401, not the member 403. CC-07 (console
sign-in) and CC-08 (lapsing the club) not run. Log: test-runs/2026-11-13-pre-master-specs/run.md.

Run 2026-11-14 02:53Z (branch fix/club-token-refresh-grace, dev version 766d77cf, B = web app in
the built-in browser pane): CC-10 passed on B with B's own token, expired 81 min earlier and
25.35 h after its last refresh. Not yet run on A in Zoom: A rejoined at 2026-11-14 02:28:59Z, so
its token is over 24 h old only after 2026-11-15 02:29Z. Log:
test-runs/2026-11-13-club-token-refresh-grace/run.md.
