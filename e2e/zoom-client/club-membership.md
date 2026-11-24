---
id: club-membership
title: Club membership by Zoom account (invite code, 3 places, leave, remove, block, owner)
status: stale
covers:
  - worker/club.js
  - worker/club-admin.js
  - worker/club-admin-routes.js
  - worker/club-places.js
  - packages/shared/club.js
  - packages/ui/ClubSetupCard.jsx
  - apps/zoom-app/src/components/UpgradeModal.jsx
  - apps/zoom-app/src/main.jsx
  - apps/zoom-app/src/utils/zoomIdentity.js
  - apps/zoom-app/src/utils/pendingClubCode.js
  - apps/web/src/utils/webIdentity.js
  - apps/web/src/pages/ProActivate.jsx
  - apps/web/src/components/ClubCodeSection.jsx
  - apps/web/src/pages/ClubAdmin.jsx
  - scripts/club-cli.mjs
automated:
  - e2e/zoom.club-join.spec.js
  - e2e/web.club-join.spec.js
  - worker/club-places.test.js
  - worker/club-membership.test.js
  - worker/club-membership-admin.test.js
  - worker/club.test.js
  - worker/club-admin-routes.test.js
  - packages/shared/__tests__/clubAccount.test.js
  - packages/shared/__tests__/clubOutbox.test.js
  - apps/zoom-app/src/components/UpgradeModal.clubJoin.test.jsx
  - apps/web/src/pages/ClubAdmin.members.test.jsx
needs:
  - this branch deployed to dev (`npm run cf:deploy:dev`); the deploy output lists the
    `ClubPlaces` Durable Object binding
  - FLAGS_FORCE "1,new_look=0" on dev (the club doors are behind `pro`; these steps are written
    for today's panel)
  - after the deploy, `node scripts/club-cli.mjs backfill-club-of --env dev --apply` once (Q7;
    without `--apply` it only lists what it would write)
  - a dev club with a code (Claude Test Club, or `club-cli create --env dev --uid <test uid>`);
    note who its owner is (`club:<id>.ownerUid`)
  - Zoom account A, the test account on the Mac, approved for the dev app
  - for the `human` steps that need it, a second Zoom account B (Q6); without one, mark those
    steps ⏭ with the reason
  - for CM-03, CM-04 and CM-14, a fresh dev club whose fake members are in KV before its
    first request (`club-cli create --env dev --name "Places test" --uid <its admin's uid>`,
    then `club-member:<id>:zoom:<fake uid>` with `{role:'member'}` plus `club-of:zoom:<fake
    uid>` for each, then the first request). `ClubPlaces` reads KV once, on the club's first
    activate, `GET /api/club` or roster request, and never again: rows seeded into a club
    whose counter already ran (the dev club after CM-01) are not counted. Its admin must not
    be A, who joins it; without a second account, use the billing-address link (`--email`) or
    mark the admin halves ⏭. Delete the club and its keys at the end
verified_at: never
verified_on: never
---

# Club membership by Zoom account

Issue #167. Club Pro belongs to Zoom accounts, not devices: one code per club, 3 places
besides the owner (the account that pays), one club per account, and nothing stored per
device (no `club-device:` rows, no `X-Club` header, no 24 h club token). The place count is
kept by the `ClubPlaces` Durable Object (one per club), so simultaneous joins can't make a
4th place. It reads its club id from `ctx.id.name` and seeds itself once from the club's live
member rows (owner left out) the first time it is used, so the dev clubs need no extra step.

## Purpose
Catches a code that still admits a signed-out or guest device, Pro that stays on one webview
instead of following the account, a 4th account let in, a removed or blocked account that
keeps Pro, an owner who can leave or be removed, and a club request sent before the Zoom
session exists (which made the server unable to name the caller, see club-card-sets'
2026-11-16 run).

## Steps

### CM-01 · auto · A, signed in and approved, joins with the code
Do: with A not in any club (`club-of:zoom:<A uid>` absent; leave first if needed), open the
timer in Zoom, Upgrade, type the club code under "Already on Pro with your club?", Activate.
Expect: the Pro panel reads "You're on Pro through <club>". No "No sign-in needed" and no
"This device is on Pro" anywhere. The club badge and club features appear without a reload.
Evidence: `wrangler tail --env dev` shows `POST /api/club/activate` → 200 with an
`authorization` header and no `x-club`; KV has `club-member:<id>:zoom:<A uid>` (`role:
member`) and `club-of:zoom:<A uid>`; no `club-device:<id>:` key was written. PostHog
`club_code_activated` with `places_used`.

### CM-02 · auto · Pro follows the account, not the webview
Do: open the web app at `www.timer-dev…/timer/app` signed in as A in a fresh browser profile
(or clear the Zoom webview's storage through its inspector, `defaults write ZoomChat
webview.context.menu true`; the Debug Panel has no clear-storage control), then open the
timer again.
Expect: club Pro is back with no code typed, once the session has resolved.
Evidence: tail shows `POST /api/zoom/session` (entitlement `club` set) and then `GET
/api/club` → 200; `toastmaster_club` holds A's `uid` and no `clubToken`.

### CM-03 · auto · The 4th account is refused with the full message
Do: on the fresh club (see needs), with the owner plus 3 fake members written to KV before
its first request, enter its code as A (in no club: leave first if needed).
Expect: "This club's Pro is full (3 of 3). Ask the person who shared the code to free a
place." A is not joined.
Evidence: tail `POST /api/club/activate` → 409 `full` with `placesUsed: 3`; no member row or
`club-of` for A. PostHog `club_code_rejected` `reason: full`.

### CM-04 · auto · A freed place admits the next account; admins see the count
Do: as the fresh club's admin (see needs), remove one fake member in the console (Remove,
CM-06's flow), then enter its code as A. As that admin, open the Pro panel and `/club/admin`.
Expect: A joins. The admin sees "N of 3 places used" next to the code in the Zoom Pro panel and
in the console; a member or editor sees no count. Re-entering the code as A changes nothing.
Evidence: `placesUsed` in the activate answer and in `GET /api/club/roster` `counts`.

### CM-05 · auto · A leaves, after a confirm
Do: as A (a member, not the owner), Pro panel → "Leave <club>" → Leave.
Expect: the panel asks in place (Cancel / Leave): "Leave <club>? You'll lose its Pro on every
computer where you're signed in." After Leave, club Pro is gone; on reopening the timer it
stays gone. The console no longer lists A and the place count went down by 1.
Evidence: tail `POST /api/club/leave` → 200 with `authorization`; KV member row and `club-of`
for A are gone. PostHog `club_left`.

### CM-06 · auto · An admin removes A in the console; A can rejoin
Do: with A a member again, open `/club/admin` as the club admin; A's role select → Remove →
confirm. Reopen the timer as A. Then enter the code again as A.
Expect: the confirm says the place is freed and mentions Block. A drops off the roster (no
"Removed" state). A's next open has no club Pro. Entering the code joins A again.
Evidence: tail `POST /api/club/members/<A uid>/role` (`revoked`) → 200, then A's `GET
/api/club` → 404 `no_club`, then `POST /api/club/activate` → 200. No `x-club` on any request.

### CM-07 · auto · An account in one club can't join another
Do: with A in club 1, enter the code of a second dev club (`club-cli create --env dev`, no `--uid`;
delete it at the end) at `www.timer-dev…/pro/<CODE>` signed in as A: a member's Zoom Pro panel
shows Leave and no code field, so this can't be typed in Zoom.
Expect: "You're already in <club 1>. Leave it to join another club."
Evidence: tail `POST /api/club/activate` → 409 `already_in_club`. PostHog `club_code_rejected`
`reason: already_in_club`.

### CM-08 · auto · A new code: the old one admits nobody, members keep Pro
Do: `node scripts/club-cli.mjs rotate --env dev --club <clubId>`; reopen the timer as A (a
member); then, as an account outside the club, enter the old code.
Expect: the CLI prints the club with its new code and says every member keeps access (no
device count any more). A keeps club Pro. The old code answers "That code isn't active.
Check with your club officer."
Evidence: KV `club-by-code:<old>` gone, `club-by-code:<new>` present; A's member row untouched.

### CM-09 · human · Signed out of Zoom, nothing is sent
Do: sign out of the Zoom client, open the timer from Apps, Upgrade, type the code, submit.
Expect: "Sign in to Zoom, then open the timer again to join your club". The free timer still
runs a speech.
Evidence: tail shows no `POST /api/club/activate`. PostHog `club_code_rejected` `reason:
sign_in_required`.

### CM-10 · human · Guest mode: Approve, then the typed code is sent
Do: remove the app's grant (Zoom web → Apps → Manage → Remove, without uninstalling the
client), open the timer, Upgrade, type the code, submit; press Approve and approve in Zoom.
Expect: "Approve Toastmusters Timer in Zoom to join your club" with an Approve button; after
approving A joins without retyping the code: in the panel when Zoom reports the approval while
it is open (it watches for 2 minutes), otherwise on the next open.
Evidence: no activate before approval (PostHog `reason: approve_required`), then
`POST /api/club/activate` → 200; sessionStorage `toastmaster_pending_club_code` cleared.

### CM-11 · human · The web link, signed out, then signed in
Do: in a browser with no session cookie, open `https://www.timer-dev.simple-tech.app/pro/<CODE>`;
press "Sign in with Zoom to join" and sign in.
Expect: the page shows "Sign in with Zoom to join" and joins nothing; after sign-in it comes
back to `/pro/<CODE>` and shows "You're on Pro through <club>".
Evidence: the link's `returnTo` is `/pro/<CODE>`; tail `POST /api/club/activate` → 200 only
after sign-in.

### CM-12 · auto · No club request before the Zoom session
Do: quit and reopen the timer as A (a member) while tailing the dev Worker.
Expect: club Pro appears after the panel has loaded (not before the first paint).
Evidence: in the tail, `POST /api/zoom/session` comes before every `/api/club*` request
(`GET /api/club`, any `POST /api/club/meetings/…/speeches`); no request carries `x-club`.

### CM-13 · human · Offline: the saved copy keeps Pro; a finished speech uploads later
Do: as A (a member, opened once online), turn Wi-Fi off, reopen the timer, time a short speech
and FINISH; turn Wi-Fi on and reopen.
Expect: offline, club Pro and the club badge stay on; the speech is listed. Back online, the
speech reaches the club's History.
Evidence: `toastmaster_club_outbox` holds the speech while offline and is empty after;
tail shows `POST /api/club/meetings/<id>/speeches` → 200 after reconnecting.

### CM-14 · auto · Block a member from the console's "…" menu
Do: on the fresh club (see needs, its fake members seeded before its first request), open
`/club/admin` as its admin; on a fake member's row press "…" → Block → confirm.
Expect: the confirm says they lose Pro at their next open, the place is freed and the code
won't let them back in. The member moves to a **Blocked** section; the place count drops by 1.
Evidence: tail `POST /api/club/members/<uid>/block` → 200; KV member row is
`{ blockedAt, blockedBy }` with no role and `club-of:zoom:<uid>` is gone. PostHog
`club_member_blocked`.

### CM-15 · human · A blocked account is refused; Unblock lets it rejoin
Do: block B (second account) as in CM-14; as B enter the code. Then Unblock B in the console
and enter the code as B again.
Expect: blocked, B sees "That code isn't active. Check with your club officer." and is not
joined. After Unblock, B leaves the Blocked list, is not put back by itself, and joins with
the code while a place is free.
Evidence: activate → 400 `invalid_code`, then after Unblock → 200. PostHog
`club_member_unblocked`.

### CM-16 · human · The owner can't leave and isn't counted
Do: as the club's owner (the account that paid), open the Pro panel in Zoom and `/club/admin`.
Expect: the Pro panel shows the code and "N of 3 places used" and no Leave. In the console the
owner's row reads "Owner", with no role select and no "…" menu. The owner isn't counted in the
places. ⏭ with the reason if the test account isn't the dev club's owner.
Evidence: `GET /api/club` returns `isOwner: true`; a forced `POST /api/club/leave` as the owner
returns 409 `owner`.

Run 2026-11-24 (factory/167 9d094d6, dev 19f7a29c with FLAGS_FORCE "1,new_look=0"; A's own Pro
entitlement removed for the plain-account steps and restored): CM-01, CM-03, CM-05, CM-08 and
the Zoom halves of CM-04 and CM-16 passed, and so did CM-12: every ⋯ → Refresh app sent
session → profile → club in that order. On the 4 cold opens from Apps the Worker tail showed
only `GET /`, but PostHog shows each one resolved its session about 1 s after the page view
(`$set` with `zoom_identified: true`, which only a successful `/api/zoom/session` answer gives):
the tail drops requests on a cold open, so prove those with PostHog. The same day, on the web
console signed in as the owner (FLAGS_FORCE "1,new_look=0"; web sign-in is dark while `pro` is
off): CM-04's and CM-16's console halves, CM-14 (Block), CM-15's Unblock half and CM-06's
Remove passed on seeded fake members; the forced owner leave answered 409 `owner`. The console
confirms with `window.confirm`, which freezes a background tab under browser automation: stub it
from a page script and read the text it was given. CM-02 passed on the web route (the second pass: /timer/app
signed in as A rebuilt the club copy from GET /api/club, no clubToken). CM-07 ⏭ (no way to run it in
Zoom; Do line fixed), CM-06's and CM-15's halves that need a second real account ⏭, human
steps ⏭. Log: test-runs/2026-11-24-167-club-account-invites/run.md.

## Not covered
- The Durable Object's serialisation of simultaneous joins (AC-3's race): unit-tested in
  `worker/club-places.test.js`; two real accounts can't be made to press at the same instant.
- Grace, lapse and renewal for members who joined by account: unchanged logic, covered by
  [club-renewal-reminder](club-renewal-reminder.md) and the lapse step in
  [club-card-sets](club-card-sets.md).
- Replaces the `pro-club` plan's P4 (`docs/ZOOM_TEST_PLAN.md`); P1–P3 and P5–P7 are still
  not migrated.
