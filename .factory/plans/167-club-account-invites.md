# Clubs: an invite code for up to 3 other Zoom accounts, and club Pro follows the account (#167)

## Problem
Club Pro belongs to a device today. A browser or Zoom webview types the code, gets a 24 h club
token (`X-Club`) and a `club-device:` row. Pro drops when the token expires, the webview is
cleared or the person changes computer, and a code admits any number of devices with or
without an account. Club Pro should belong to Zoom accounts: one code per club, 3 places
besides the owner, one club per account, and nothing stored per device. Production has no
club records (2026-11-06), so no migration is needed.

## Findings
Read on `dev` 26c4477. Supersedes the plan on `factory/146-club-membership-zoom-account`,
which kept device tokens.

**Worker: joining and state** (`worker/club.js`)
- `handleClubActivate` (254-296), in order: throttle by IP (38-48, 429 at 260), then
  `normalizeCode`, then `club-by-code:`, then `resolveAccess` with no uid (277; not entitled
  → `invalid_code`). Only then `readSession` (282), which is optional. Then `attachDevice`
  (286-292). The session is never required.
- `attachDevice` (326-360) writes the device row and carries its own `revokedAt` (331-341).
  It writes a member row only when it is missing (349-357) and never reads
  `member.revokedAt`. That is the revocation hole. There is no cap and no one-club check.
- `verifiedClubId` (233-245) checks the device row only.
- `handleClubCreate` (382-422) calls `attachDevice` (401), so the creator gets a device row
  and a token too.
- `handleClubLeave` (439-452) deletes this device's row and leaves the member row.
- `handleClubState` (463-496), `GET /api/club`: device row missing or revoked → 403 (475).
  Re-mints the token (489-493).
- `buildClubState` (179-218) never touches devices. It returns `code`/`shareUrl` to admins
  only (209-210).
- `CLUB_DOORS` (509) are activate, create, magic-link and manage. `pro` gates them (525-528).

**Worker: the token and its readers**
- `worker/club-token.js`: `mintClubToken` (47), `verifyClubToken` (79-118), TTL 24 h (23),
  `readClubHeader` (138).
- `readClub` (`worker/auth.js:137-141`) is HMAC only. Every reader of `X-Club` already has the
  session uid, except the speech, history and share routes:

  | Site | Today | Uid? |
  |---|---|---|
  | `assets.js:84`, `profile.js:69` | `verifiedClubId(readClub)` then `resolveAccess` | required |
  | `club-presets.js:139-156`, `club-cards.js:154-176` (`requirePublisher`) | same, plus `canPublish` | required |
  | `club-cards.js:265` `handleCardDownload` | `readClub()?.clubId`, else the admin context | no |
  | `club-meetings.js:221-236` `appendSpeech` | `verifiedClubId`, no uid by design | no |
  | `club-meetings.js:278`, `:358` list and read | claims.clubId, HMAC only | no |
  | `club-share.js:122-135` | `verifiedClubId` | no |
  | `club-admin-routes.js:94-131` `readAdminContext` | session uid plus X-Club claims, else `club-admin-of` | yes |
  | `session.js:98`, `me.js:48` | `resolveAccess({uid, clubId: readClub()?.clubId})` | yes |

- `resolveAccess` (`worker/entitlements.js:233-261`) takes the club id from its caller and
  never looks one up by uid. Grace and lapse live in `subscriptionGrantsAccess` (60-74) and
  stay as they are.

**Worker: members, admin, code**
- Keys (`worker/club-admin.js`):
  - `club-device:` 141
  - `club-member:<clubId>:zoom:<uid>` 142, holding `{role, displayName, addedAt, revokedAt}`
  - `club-admin-of:zoom:<uid>` 162-181, admins only and single-valued
  - No uid→club index exists for other members.
- `readMemberRole` (200-212) treats a revoked row as no role.
- `createClubFromPending` (242-293) writes the buyer's admin member row when `pending.uid` is
  set. The club record has no owner uid, only `stripeCustomerId` and `billingEmail`. The
  owner's uid can be found through `stripe:customer:<cus>` (`worker/billing.js`
  `lookupUidByCustomer`, 56).
- `rotateClubCode` (309-344) revokes every device row unless `revokeDevices === false`
  (325-341). Its only caller is `scripts/club-cli.mjs` `rotate` (313-318).
- `club-admin-routes.js`:
  - `handleClubRoster` (192-282) groups device rows by uid; `guestDevices` at 231-233.
  - `handleMemberRole` (315-371): `revoked` sets `revokedAt` (341-349); any other role
    restores, with no cap check; `last_admin` 409 at 336-339; device cascade at 357-368.
  - `handleMemberName` (388-414) creates a member row when it is missing. With a cap, that
    would take a place without a join.
  - `handleDeviceRevoke` (423-442); dispatched at 608-612.
- `club-create.js` `createClubForSubscriber` (59-121) is called from three places: the
  checkout webhook (`stripe-webhook.js:97-117`), `/api/club/create` and `club-cli.mjs create`.

**Shared** (`packages/shared/club.js`)
- `readStored` (94-104) rejects an entry with no `clubToken`.
- `clubDeviceId` (125-136) and `clubHeaders` (668-671).
- `toCacheEntry` (699-722) has no uid, so the cache isn't tied to an account.
- `initClubFromCache` (740-744) sets Pro before the first paint.
- `refreshClub` (915-971):
  - skips when the cache is under 24 h old (920);
  - on 401/403/404 calls `leaveClub()` (939-942), which also POSTs leave.
- `activateClub` (780-824) sends `{code, deviceId}` and maps unknown errors to
  `invalid_code`.
- `leaveClub` (986-1030).
- Raw `X-Club` is built in `clubCards.js:57-67` and `:148-172`. `clubHeaders` is used by:
  - `clubPresets.js:252-263`;
  - `clubArchive.js` `getJson` 531-540, `shareMeeting` 604-626 and `uploadOne` 349-374;
  - `profileSync.js:138`, `cardAssetSync.js:103` and `entitlement.js:92`;
  - `apps/zoom-app/src/utils/zoomIdentity.js:55`;
  - `apps/web/src/pages/ClubAdmin.jsx` 29-42 and 397-399.
- **Speech outbox:**
  - `recordSpeech` (`clubArchive.js:281-310`) queues only with a `clubToken`.
  - `drainOutbox` (466-508) stops without one (479) and **drops the entry on any non-5xx
    status, including 401** (497-501). That is how an offline or early speech is lost.

**Zoom app**
- `main.jsx` runs `initClubFromCache()` at 17, before render.
- `refreshClub` (53) and `drainOutbox` (71) run at module load, before
  `resolveZoomIdentity()` (78) has a session (#164).
- `setEntitlement(entitlement ?? FREE)` (82) overwrites club Pro when the session call fails
  (offline).
- `zoomIdentity.js` `resolveZoomIdentity` (146-151) is single-flight, with no re-resolve.
  - Auth status is `unauthenticated` | `authenticated` (guest mode) | `authorized`
    (`zoomSdk.js:2236-2238`).
  - The SDK exposes no uid. Only the Worker can decrypt the app context, so offline the client
    can tell signed out from signed in, but not which account (see Q3).
  - The Worker answers a guest with `identified:false, isGuest:true` and no token
    (`session.js:83-86`).
- `promptZoomAuthorize` (`zoomSdk.js:1957-1971`) is used only by
  `ZoomConnectionNotice.jsx:251-258`.
- `UpgradeModal.jsx`:
  - `handleActivate` 196-220 (`club_code_rejected` 207, `club_code_activated` 212-218 with
    `is_guest`);
  - `handleLeave` 222-227, no confirm;
  - code form 313-342, with "No sign-in needed." at 319;
  - joined state 346-385, "This device is on Pro through" at 352 and "Leave this club on this
    device" at 375-380;
  - guest branch 468-478.
- The admin's code goes through `renderClubSetup` (`packages/ui/ClubSetupCard.jsx`, 286-302).
- Design B reaches the same modal through `b/MoreMenu.jsx` (140-145, "Join my club with a
  code"), `b/ProChip.jsx` and `b/ReportTabB.jsx`.

**Web**
- `main.jsx:44` refreshes the club next to `startWebSession` (39) without waiting for it.
- `webIdentity.js:32` fetches `/api/me` without X-Club, then calls
  `setEntitlement(identity.entitlement ?? FREE)` (80).
- `ProActivate.jsx` activates on load (35-58) with no sign-in, and its copy is "on Pro in this
  browser" (94).
- `ClubCodeSection.jsx`: activate 42-67; leave 69-74 with no confirm; "No sign-in needed."
  at 117.
- `ClubAdmin.jsx`:
  - `MemberRow` 126-210, with "No access" in the role select at 186-197 and no confirm;
  - `DeviceRow` 212-233, `handleDevice` 565-581;
  - "N devices · N people" 629-632;
  - "Guest devices" 658-673.
- `signInUrl(returnTo)` (`webIdentity.js:59-61`) and `sanitizeReturnTo`
  (`worker/auth.js:180`) already carry `/pro/<CODE>` through sign-in.

**Analytics**: client only. `club_code_rejected.reason` is the server's `error`. Events are
listed in `docs/CLUBS.md:336-345`.

**Tests today**
- Worker:
  - `club.test.js`: activate 112-281, state 283, leave 367, verifiedClubId 405, rotate 443
  - `club-token.test.js`
  - `club-admin-routes.test.js`: roster 238, role 281 (cascade 297), devices 399
  - `gating.test.js`: club devices 132, revoked device 198
  - `club-presets`, `club-cards`, `club-meetings` and `club-share` tests, which all use an
    `activated` token helper
  - `club-create.test.js:232`
  - `flags.test.js` 753-810
  - `session.test.js`, `me.test.js`
- Shared: `packages/shared/__tests__/club.test.js` (cache 70, activate 112, refresh 234,
  leave 526), `clubArchive.test.js`, `clubCards.test.js`, `clubPresets.test.js`.
- Zoom: `UpgradeModal.test.jsx` (code entry 76, activated device 227), `b/Phase3.test.jsx`,
  `b/TopBar.test.jsx`, `zoomIdentity.test.js`.
- Web: `ClubAdmin.test.jsx` (roster 119, guest device revoke 204), `Account.test.jsx:373`,
  `FlagGate.test.jsx:64-88`. There is no ProActivate or ClubCodeSection test.
- Playwright: `zoom.club-pro-gate`, `zoom.stage-badge` and `zoom.new-look` seed
  `toastmaster_club` with `clubToken` and a fresh `lastRefreshAt`, so `/api/club` is never
  called. No spec covers joining or leaving.
- Zoom-client specs:
  - `club-card-sets` (CC-03 to CC-09 use a second device "B" that types the code),
    `club-pro-gate` and `club-renewal-reminder` (CR-02/03 force a refresh on the web app as a
    second device) all cover `packages/shared/club.js`.
  - `club-card-sets` also covers `apps/zoom-app/src/main.jsx`.
  - `new-look.md:185-187` quotes "This device is on Pro".
  - Nothing covers `worker/club.js`, `UpgradeModal.jsx`, `ClubAdmin.jsx`, `ProActivate.jsx`
    or `ClubCodeSection.jsx`. `pro-club` is not migrated.
  - `.claude/skills/zoom-app-testing/references/toastmusters.md` lists one test Zoom account.

## Approach
One PR, landed as ordered commits: Worker, then shared, then the apps, then docs and specs.
A Worker without `X-Club` breaks old bundles, so it can't ship alone; production has no clubs,
so nothing breaks there.

**Worker**
1. **Account index and lookup** (`club-admin.js`).
   - `clubOfKey(uid)` = `club-of:zoom:<uid>` → `{ clubId, at }`, single-valued (one club per
     account).
   - `memberClub(env, uid)` reads the index, then the club record and the member row. It
     returns `{ clubId, club, role }`, or null when any is missing or the row is revoked. A
     dangling index entry is deleted on read.
   - The index replaces `club-admin-of` for the admin door. Stop writing `club-admin-of`;
     leave old keys alone.
2. **Owner and places.**
   - `createClubFromPending` writes `ownerUid: pending.uid` on the club record.
   - For a record without it, `clubOwnerUid(env, club)` falls back to
     `lookupUidByCustomer(stripeCustomerId)`.
   - `placesUsed(env, clubId, club)` lists `club-member:<clubId>:` and counts rows that are
     not revoked and not the owner. `CLUB_PLACES = 3`.
   - Create, checkout and CLI `create --uid` write the owner's admin row and index, as today.
3. **Activate** (`handleClubActivate`): throttle, then **session required** (`401
   sign_in_required`, before the code lookup), then code, then entitled. Then, in order:

   | Case | Answer |
   |---|---|
   | Own live member row, or the owner | success, no extra place |
   | Revoked row | 400 `invalid_code` (Q2) |
   | `memberClub(uid)` is another club | 409 `already_in_club` with `clubName` |
   | `placesUsed >= 3` | 409 `full` with `placesUsed`, `placesTotal` |
   | Otherwise | write the member row (`role:'member'`) and the index |

   Success returns `buildClubState(...)` plus `placesUsed`. No token, no device row, no
   `deviceId` in the body. `attachDevice` and `readDeviceId` go.
4. **State, leave, create.**
   - `GET /api/club` needs a session (401 otherwise). It finds the club with
     `memberClub(uid)`; no club → 404 `no_club`, revoked → 403.
   - `buildClubState` adds `placesUsed`/`placesTotal` for admins, next to `code`.
   - `POST /api/club/leave` needs a session. It deletes the member row and the index, clears
     `club-admin-of`, and refuses the last admin with `409 last_admin` (`activeAdmins`).
   - `/api/club/create` drops `attachDevice` and the token.
5. **Every `readClub` site uses `memberClub(sessionUid)`**:
   - assets, profile, presets, cards (upload, publish, download);
   - meetings (append, list, read) and share;
   - the admin door;
   - `session.js:98` and `me.js:48`. The entitlement there now carries `club` for every
     member, which is what makes Pro follow the account on first paint.

   `appendSpeech`, list, read and share now need a session; a non-member gets 403. Delete
   `worker/club-token.js`, its test, and `readClub` in `auth.js`.
6. **Admin.**
   - The roster lists people with no devices. `counts` becomes `{ people, placesUsed,
     placesTotal }`, and each member has `isOwner`.
   - `handleMemberRole`:
     - `revoked` sets `revokedAt`, deletes the index and frees the place; the device cascade
       goes.
     - Restoring a revoked person checks for a free place (409 `full`) and that they aren't in
       another club (409 `already_in_club`), then writes the index.
   - `handleMemberName` only renames existing rows (404 otherwise).
   - Remove `handleDeviceRevoke` and its route.
7. **Code rotation.** `rotateClubCode` stops touching devices; members stay. CLI:
   - `rotate` prints the new code only;
   - `prune-devices` goes;
   - `backfill-admin-index` becomes `backfill-club-of`, which writes the index from live
     member rows, newest first, and reports any account in two clubs. Run it once on dev.

**Shared** (`packages/shared/club.js` and its users)
8. **Cache tied to an account.**
   - The entry drops `clubToken` and gains `uid`. `readStored` keys on `club.id` and drops an
     old token-shaped entry.
   - `clubDeviceId`, `clubHeaders` and the `X-Club` uses in `clubCards.js`, `clubPresets.js`,
     `clubArchive.js`, `profileSync.js`, `cardAssetSync.js` and `entitlement.js` go. Each
     request sends the Bearer (Zoom) or the cookie (web).
9. **Startup.** `initClubFromCache` no longer sets Pro before the first paint (Q4). A new
   `syncClubWithIdentity({ identified, uid, authStatus, reachable, entitlement, getToken })`
   runs after identity resolves:

   | Identity | What happens |
   |---|---|
   | Identified, same uid as the cache, or no cache, and the session says a club exists | `refreshClub` (`GET /api/club`); its answer replaces the cache |
   | Identified, and the session's entitlement has no `club` | clear the cache (a refusal) |
   | Identified with a different uid | clear the cache first |
   | Session unreachable, Zoom status `authorized` | keep the cache and apply its plan |
   | Signed out, or guest mode | never apply the cache |

   `refreshClub` loses the 24 h skip; it is one GET per open, for members only. 401/403/404
   clear the cache locally through a new `forgetClub()` and send no leave POST.
10. **Join and leave.**
    - `activateClub(code, { getToken })` returns the server's reason, including the new ones
      plus `clubName`, `placesUsed` and `placesTotal`.
    - `leaveClub()` POSTs with the session and clears only after a 2xx; `last_admin` comes back
      as an error.
11. **Outbox.**
    - `recordSpeech` queues when `club.club?.id` and `clubFeaturesOn`.
    - `drainOutbox` waits for a session token (no token → keep the queue).
    - It keeps entries on network errors, 5xx and **401**, and drops them on 400/403/404.
    - Both apps call it after identity resolves.

**Zoom app**
12. **`main.jsx`.**
    - `refreshClub` and `drainOutbox` leave module load and run in the
      `resolveZoomIdentity().then`, through `syncClubWithIdentity`.
    - An unreachable session no longer sets FREE over club Pro.
    - `zoomIdentity.js` gains `refreshZoomIdentity()` (drops the single-flight promise and
      resolves again) for after an approval.
13. **`UpgradeModal.jsx`** (the classic and design-B entry points share it).
    - The code form, by auth status:
      - `unauthenticated`: "Sign in to Zoom, then open the timer again to join your club",
        and nothing is sent.
      - `authenticated` (guest mode): "Approve Toastmusters Timer in Zoom to join your club",
        with an **Approve** button (`promptZoomAuthorize`). The typed code is kept in
        sessionStorage `toastmaster_pending_club_code`. It is sent once
        `refreshZoomIdentity()` reports `authorized`, in this panel or on the next load, then
        cleared.
      - `authorized`: send.
    - Errors:
      - `full`: "This club's Pro is full (3 of 3). Ask the person who shared the code to free
        a place."
      - `already_in_club`: "You're already in <club>. Leave it to join another club."
    - Joined copy: "You're on Pro through <club>".
    - **Leave**, with a confirm: "Leave <club>? You'll lose its Pro on every computer where
      you're signed in." `last_admin` shows the existing message.
    - Admins see "N of 3 places used" beside the code: a `placesUsed` prop on
      `packages/ui/ClubSetupCard.jsx`.

**Web**
14. **`main.jsx` and `webIdentity.js`.** Refresh the club and drain the outbox after
    `startWebSession` resolves, through `syncClubWithIdentity` (`reachable` false when
    `/api/me` fails). An `/api/me` failure doesn't set FREE over club Pro.
15. **`ProActivate.jsx` and `ClubCodeSection.jsx`.**
    - Signed out: "Sign in with Zoom to join", a link to `signInUrl('/pro/<CODE>')`. It comes
      back to `/pro/<CODE>` and joins.
    - The new error copy as in step 13, "You're on Pro through <club>", and Leave with the same
      confirm.
16. **`ClubAdmin.jsx`.**
    - A people-only roster with "N of 3 places used". The owner is marked and isn't counted.
    - The device rows, "Guest devices" and "N devices" go.
    - The role select's "No access" becomes **Remove**, with a confirm: "Remove <name>? They
      lose the club's Pro at their next open, and the place is freed." (Q5)
    - A removed person shows "Removed", and choosing a role restores them (`full` and
      `already_in_club` shown inline).
    - Console API calls send the cookie only.

**Analytics**
- `club_code_rejected.reason` adds `full`, `sign_in_required`, `approve_required` and
  `already_in_club`. `approve_required` is decided on the client before any send.
  `sign_in_required` comes from the client too, or from the server if a session-less request
  slips through. `full` and `already_in_club` come from the server.
- `club_code_activated` adds `places_used` and drops `is_guest`. `club_left` is unchanged.
  `docs/CLUBS.md` lists the props.

**Docs:** rewrite the membership parts of `docs/CLUBS.md` (3-6, 11-32, 51-127, 156-220,
277-289, 336-345). Also `docs/BILLING.md` 33-41 and 102-108, `docs/ZOOM_LISTING_PRO.md` 21-26
and 118-120 (drop "no sign-in"), `docs/ZOOM_TEST_PLAN.md` P4 (258-268, 383-401), and the test
references file (`club-device`, `X-Club`, how the device joins).

**Rejected**
- Keep device tokens with a grace period plus a restore route (#145, #161): the issue drops
  devices entirely.
- A Durable Object or a count on the club record to make the 3-place cap atomic:
  KV has no transaction, and webhook writes to the club record would race a counter. A rare
  4th place from two simultaneous joins is accepted (Q8).
- Apply the cache before the first paint and correct it after the session: that briefly shows
  a different account's club, which AC-8 forbids.
- Keep `club-admin-of` beside `club-of`: two indexes for one fact.
- A guest-join release flag (as #146 planned): the issue drops guest joins outright, and
  `FLAGS_FORCE="1"` would turn it on on dev.

## Acceptance criteria
From the issue, unchanged in substance; IDs kept.
- **AC-1** (joining):
  - **a.** Given a signed-in Zoom user who approved the app, when they enter a valid code for
    a club with a free place, then they join, the timer shows the club's Pro, and the console
    lists them.
  - **b.** Given a user signed out of Zoom, when they enter a code, then no request goes out,
    they see "Sign in to Zoom, then open the timer again to join your club", and the free
    timer works.
  - **c.** Given a user in guest mode, when they enter a code, then they see "Approve
    Toastmusters Timer in Zoom to join your club" with an Approve button. After approving,
    the typed code is sent without retyping.
  - **d.** Given a signed-out browser, when it opens `/pro/<CODE>` or enters a code on
    Account, then it shows "Sign in with Zoom to join". After sign-in it returns to
    `/pro/<CODE>` and joins.
- **AC-2** (follows the account):
  - Given a member, when they open the timer on another computer or the web, signed in to the
    same account, then they have the club's Pro with no code. That holds after clearing
    storage too.
  - Given a different account on a member's computer, then it gets nothing from the club.
- **AC-3** (3 places):
  - Given the owner plus 3 members, when a 4th account enters the code, then it isn't joined
    and sees "This club's Pro is full (3 of 3). Ask the person who shared the code to free a
    place."
  - Admins see "N of 3 places used" next to the code, in the console and in the Zoom Pro
    panel.
  - Re-entering the code as a member uses no place.
  - A freed place admits the next account.
- **AC-4** (leave and remove): Given a member who chooses Leave (Zoom or web), or whom an
  admin removes in the console, after a confirm:
  - they lose the club's Pro wherever they're signed in, at their next open;
  - the console drops them and the place is free;
  - a removed account's code entry is refused until an admin gives a role again (when a place
    is free);
  - the last admin can't leave or be removed.
- **AC-5** (one club): Given an account in a club, when it enters another club's code, then it
  isn't joined and sees "You're already in <club>. Leave it to join another club."
- **AC-6** (new code): Given the CLI replaces the code, then the old code admits nobody and
  every member keeps access.
- **AC-7** (no device bindings):
  - Given any join, open, leave, removal or code change, then the Worker reads and writes no
    `club-device:` record and no request carries `X-Club`.
  - The console lists people only, with no per-device revoke.
  - No screen says "No sign-in needed" or "This device is on Pro"; the joined state reads
    "You're on Pro through <club>".
- **AC-8** (startup and offline):
  - No club request goes out before the Zoom session exists.
  - With the server unreachable, the saved copy keeps the club's Pro. The next answer
    replaces it and a refusal clears it.
  - The copy is never used for a different account or a signed-out user.
  - A speech finished offline or before the session uploads later and isn't dropped.
- **AC-9** (unchanged features): shared presets and the club card set, the brand kit, the
  archive, roles (only admins see the code), grace, lapse and renewal, the `pro` flag, the
  code format and rate limit, the console email link, and club creation at checkout and with
  "Set up my club" all keep working for members who joined by account.
- **AC-10** (analytics):
  - `club_code_rejected.reason` gains `full`, `sign_in_required`, `approve_required` and
    `already_in_club`.
  - `club_code_activated` gains `places_used`.

## Test list
| AC | Unit | Playwright | Zoom-client spec |
|---|---|---|---|
| AC-1a | `worker/club.test.js` activate: member row and `club-of` written, state returned without `clubToken`; `UpgradeModal.test.jsx` authorized send | `e2e/zoom.club-join.spec.js` NEW: join shows "You're on Pro through" | `club-membership` CM-01 NEW |
| AC-1b | `club.test.js`: no session → 401 `sign_in_required` before code lookup; `UpgradeModal.test.jsx` unauthenticated: no fetch, copy | `zoom.club-join` signed-out case | CM-09 NEW (human: sign out of Zoom) |
| AC-1c | `UpgradeModal.test.jsx` guest: Approve calls `promptZoomAuthorize`, pending code sent after `refreshZoomIdentity` → authorized; `zoomIdentity.test.js` `refreshZoomIdentity` | `zoom.club-join` guest case | CM-10 NEW (human: remove the app grant) |
| AC-1d | `apps/web/src/pages/ProActivate.test.jsx` NEW, `ClubCodeSection` in `Account.test.jsx` | `e2e/web.club-join.spec.js` NEW: signed-out `/pro/<CODE>` links to `/api/auth/zoom/start?returnTo=/pro/<CODE>`, signed-in joins | CM-11 NEW (web, human sign-in if the browser has no cookie) |
| AC-2 | `worker/session.test.js`, `me.test.js`: entitlement carries the member's club from the uid with no header; `packages/shared/__tests__/club.test.js` `syncClubWithIdentity`: no cache plus a club in the session → refresh; other uid → clear | `zoom.club-join`: empty storage, session mock with club → Pro | CM-02 NEW (clear the webview's storage, or the web app as the same account) |
| AC-3 | `club.test.js`: 4th → 409 `full`; owner not counted; re-entry idempotent; freed place admits; `club-admin.test`/`club.test.js` `placesUsed`; `ClubAdmin.test.jsx` and `UpgradeModal.test.jsx` "N of 3 places used" | `zoom.club-join` full message | CM-03 (KV-seeded members), CM-04 NEW |
| AC-4 | `club.test.js` leave (member row and index gone, `last_admin` 409); `club-admin-routes.test.js` remove frees the place, removed re-entry refused, restore checks places; shared `leaveClub` / `forgetClub`; confirm in `UpgradeModal.test.jsx`, `Account.test.jsx`, `ClubAdmin.test.jsx` | `zoom.club-join` leave confirm | CM-05, CM-06 NEW; `club-card-sets` CC-07 edited |
| AC-5 | `club.test.js` 409 `already_in_club` with name; UI copy test | `zoom.club-join` | CM-07 NEW |
| AC-6 | `club.test.js` `rotateClubCode`: members kept, old code invalid, no device writes | — | CM-08 NEW (CLI `rotate --env dev`) |
| AC-7 | `gating.test.js` rewritten for members; grep test `worker/no-club-token.test.js` NEW (no `club-device:`/`x-club` in `worker/`, `packages/shared`, `apps/*/src`, `X-Club` absent from requests); copy assertions in modal, Account and ProActivate tests | existing club specs reseeded without `clubToken` | CM-01/CM-06 evidence (worker tail has no `x-club`) |
| AC-8 | `packages/shared/__tests__/club.test.js`: unreachable + authorized keeps the cache, signed-out/guest never applies it, refusal clears; `clubArchive.test.js`: 401 and no-token keep the entry, drain waits for the token; `apps/zoom-app` main-order test, or `zoomIdentity` hook test that no club fetch precedes the session | `zoom.club-pro-gate.spec.js` edited: the session mock delays and `/api/club` is asserted to come after it | CM-12 NEW (worker tail order); CM-13 NEW (human: Wi-Fi off) |
| AC-9 | presets, cards, meetings, share, assets, profile, `club-create` tests moved from token helpers to a member-session helper; `entitlements.test.js` unchanged | `zoom.club-pro-gate`, `zoom.stage-badge` and `zoom.new-look` reseeded (uid, no token, `/api/club` mocked) | `club-card-sets` (B = second Zoom account: CC-03, CC-06, CC-07, CC-08, CC-09 edited), `club-pro-gate` (wording), `club-renewal-reminder` (CR-02/03: reopen instead of `lastRefreshAt` 0), `stage-club-badge` (no change; run) |
| AC-10 | `UpgradeModal.test.jsx` and web tests assert `reason` and `places_used` | — | CM-01/CM-03 PostHog evidence |

The specs also get these edits:
- `new-look.md:185-187`: the joined copy.
- `INDEX.md`: add the `club-membership` row, and note under `pro-club` that P4 is now
  `club-membership`.
- `club-membership.md` `covers`: `worker/club.js`, `worker/club-admin.js`,
  `worker/club-admin-routes.js`, `packages/shared/club.js`,
  `apps/zoom-app/src/components/UpgradeModal.jsx`, `apps/zoom-app/src/main.jsx`,
  `apps/zoom-app/src/utils/zoomIdentity.js`, `apps/web/src/pages/ProActivate.jsx`,
  `apps/web/src/components/ClubCodeSection.jsx`, `apps/web/src/pages/ClubAdmin.jsx`,
  `scripts/club-cli.mjs`.

## Risk
**high.** This changes who may use a club, how removal works, and the entitlement every club
route checks.

- `riskHigh` paths touched:
  - `worker/auth.js` (`readClub` removed)
  - `worker/club-token.js` (deleted)
  - `worker/session.js`
  - `worker/entitlements.js`, only if `resolveAccess` gains a uid-to-club lookup. The plan
    keeps that lookup in `memberClub` at the callers, so ideally this file is untouched.
- Breaking on dev:
  - Old bundles that send `X-Club` lose club features until they reload.
  - Device-only (guest) joins are dropped.
  - Members with a uid need `club-cli backfill-club-of --env dev` after deploy.
- Production must still have zero `club:` records before release. Check that as part of the
  release.
- KV list is eventually consistent, so the places count can lag by seconds across PoPs.
  Together with no transaction, a 4th place is possible under simultaneous joins (Q8).
- Design B (#153–#156, merged) wraps `UpgradeModal.jsx`. Any open design-B PR rebases on
  this.
- Large diff. Ordered commits (Worker → shared → apps → docs and specs) keep review
  tractable.

## Open questions
- **Q1. Can the owner leave or be removed?** Default: same rules as any admin (blocked only as
  the last admin). The owner never counts toward the 3, even after rejoining.
- **Q2. What does a removed account see when it enters the code?** Default: the generic
  `invalid_code` ("That code isn't active"), so AC-10's reason list stays as written.
  Alternative: a `removed` reason with "An admin removed you from <club>. Ask them to add you
  back."
- **Q3. Offline, different account.** The Zoom SDK gives no uid without the Worker, so an
  offline open can't tell account A from account B. Default: offline, the cache applies only
  when Zoom reports `authorized`. The first reachable session with another uid clears it
  before any club request. That fully covers signed-out and guest users, but not a second
  authorized account opening offline on the same webview profile.
- **Q4. First paint.** Default: club Pro (badge, plan) appears once identity resolves,
  typically a few hundred ms after open, not from the cache before render. That lets AC-8's
  "never for another account" hold. The Footer/ProChip stays in its `known:false` state
  until then, so there's no "Upgrade" flash.
- **Q5. Console removal control.** Default: rename the role select's "No access" to
  "Remove", with a confirm. A removed person shows "Removed" and a role select to restore
  them. Alternative: a separate Remove button per row.
- **Q6. Second test Zoom account.** `club-card-sets`, AC-2 and AC-4 need a second account
  as the member, and the test references list only one. Default: those steps are `human`, and
  the 3-place limit uses member records seeded in dev KV. If no second account is available,
  those steps are ⏭ with that reason, and the PR lists them under "Not verified".
- **Q7. Dev data.** Default: after the dev deploy, run `club-cli backfill-club-of --env dev`.
  Device-only joins on dev are dropped, and the test Mac's account keeps its admin role
  through its member row.
- **Q8. Place-cap race.** Default: accept that two exactly simultaneous joins could make 4,
  with no lock. The console still shows the true count, and an admin can remove one.
- **Q9. Who sees "N of 3 places used".** Default: admins only, as the AC says. Members and
  editors don't see it.
- **Q10. Speeches from non-members.** Uploading a speech to the archive now needs a member
  session. Default: a non-member or signed-out host's speeches stay on their device only, as
  for any free user.
