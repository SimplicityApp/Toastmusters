# Clubs: a member is a Zoom account, and their devices rejoin without the code (#146)

## Problem
Club membership belongs to a device: each browser or Zoom webview enters the code once and
keeps a club token in local storage. A new computer, a cleared webview or a refused token
means finding the code again. Membership should belong to the Zoom account (uid), so every
device signed in to it joins by itself. A person set to "No access" can also get back in
today by entering the code on a new device. Production has no clubs and `pro` is off, so no
migration is needed.

## Findings
Read on `dev` e28d733.

**Worker: joining**
- `handleClubActivate` (`worker/club.js:254-296`) looks the code up first (263-280). Only
  after that does it read an optional session (`readSession`, 282-283). A request with no
  session still joins, as a guest.
- `attachDevice` (`worker/club.js:326-360`) re-puts the device row and carries its
  `revokedAt` (338). It writes a `member` row when it is missing (349-357). It never reads
  `member.revokedAt`. That is the hole: a revoked person who uses a new device id gets a
  fresh, unrevoked device row and a token.
- `verifiedClubId` (`worker/club.js:233-245`) checks only the device row (243). It has six
  callers: `profile.js:69`, `club-share.js:130`, `club-presets.js:147`, `club-cards.js:164`,
  `assets.js:84`, `club-meetings.js:228`.
- `handleClubState`, `GET /api/club` (`worker/club.js:463-496`), refuses a revoked device
  with 403 `club_access_revoked` (475-476). It re-mints the token with the token's own
  `claims.uid` (489-493), not the session's.
- `handleClubLeave` (`worker/club.js:439-452`) deletes only this device's unrevoked row
  (450). The member row stays.
- `CLUB_DOORS` (`worker/club.js:509`) is `activate`, `create`, `magic-link` and `manage`.
  They are gated on `pro` at 525-528. Sub-routes dispatch at 530-547.
- The token payload (`worker/club-token.js:47-64`) carries a nullable `uid`. `ver` is
  minted but never enforced.

**Worker: keys and the admin console**
- Keys (`worker/club-admin.js:110-162`):
  - `club-device:<clubId>:<deviceId>`
  - `club-member:<clubId>:zoom:<uid>`
  - `club-admin-of:zoom:<uid>`, single-valued, admins only (156-181)
- No uid→club pointer exists for members.
- `readMemberRole` (`club-admin.js:200-212`) treats a revoked member as having no role.
- `rotateClubCode` (`club-admin.js:309-344`) revokes **every** unrevoked device row
  (330-337). Its only caller is `scripts/club-cli.mjs:315`.
- `handleMemberRole` (`worker/club-admin-routes.js:315-371`):
  - "No access" is the role `revoked`. It sets `member.revokedAt` (341-349).
  - The last-admin check returns 409 `last_admin` (336-339).
  - The cascade writes `revokedAt` onto every device of that uid (357-368). Restoring the
    role never clears it.
- `handleDeviceRevoke` (`club-admin-routes.js:423-442`) revokes or restores one row.
- `handleClubRoster` (`club-admin-routes.js:192-282`) groups device rows by `uid` and lists
  uid-less rows as `guestDevices` (231-233).

**Worker: sessions and flags**
- `handleZoomSession` (`worker/session.js:67-121`) runs parallel lookups at 95-101. The
  identified response is built at 103-120, and the request already carries `X-Club` from
  `requestSession`. `handleMe` (`worker/me.js:25-62`) has its `Promise.all` at 45-50 and its
  response at 52-61.
- `FLAG_FALLBACKS` (`worker/flags.js:27-42`) declares the flags.
- **`flagOverride`** (`worker/flags.js:79-83`): `FLAGS_FORCE="1"`, the dev default, turns
  **every** declared flag on. A guest-join flag declared the usual way would therefore be
  forced on on dev. The new sign-in rule would be off exactly where the specs run, and AC-6
  could not be tested there.

**Shared and the Zoom app**
- `refreshClub` (`packages/shared/club.js:915-971`) drops the club on 401/403/404 by
  calling `leaveClub()` (939-942). That sends `POST /api/club/leave` (989-1001), so an
  automatic drop also deletes the device row on the server.
- `refreshClub` returns `null` both for "no club" and "dropped", so the caller can't tell
  the two apart.
- `clubDeviceId()` (`club.js:125-136`, key `toastmaster_device_id`) outlives `leaveClub`.
  Restoring with it therefore reuses the same device row, which AC-2 needs.
- `activateClub` (`club.js:780-824`) maps every unknown error to `invalid_code`.
- `apps/zoom-app/src/main.jsx` calls `refreshClub` (53) **before** `resolveZoomIdentity`
  (78). Nothing runs after identity resolves to restore a club. Restore has to hang off the
  identity `.then`.
- `zoomIdentity.js` `resolveZoomIdentity` (146-151) caches one promise per load, with no
  way to reset it outside tests. Auth status is `unauthenticated` (signed out),
  `authenticated` (guest mode) or `authorized` (`zoomSdk.js:2235-2240`).
- `promptZoomAuthorize()` (`zoomSdk.js:1957-1971`) is called only from
  `ZoomConnectionNotice.jsx:251-258` (`approveInZoom`).
- `UpgradeModal.jsx`:
  - `handleActivate` is at 193-217; `club_code_activated` (209) carries `is_guest`.
  - The code form (310-339) says "No sign-in needed." and is shown to guests at 465-475.
  - Leave (372-377, `handleLeave` 219-224) has **no confirm**. Its copy is "Leave this club
    on this device".

**Web**
- `apps/web/src/main.jsx:44` calls `refreshClub()` with the cookie session, before identity
  resolves.
- `pages/ProActivate.jsx` activates on load (35-58). The success copy tells the visitor to
  enter the code in Zoom (103-108). It never offers sign-in.
- `components/ClubCodeSection.jsx`:
  - It activates with no session check (49) and says "No sign-in needed." (111-139).
  - Leave has no confirm (69-74, 99-104).
  - It has no unit test; ProActivate has none either.
- `pages/ClubAdmin.jsx`:
  - The role `<select>`, including "No access", calls `onRole` with no confirm (186-197).
  - `DeviceRow` revoke is at 212-233. The guest devices section is at 658-673.
- Web sign-in already supports a return URL. `signInUrl(returnTo)` is at
  `apps/web/src/utils/webIdentity.js:59-61`, and `sanitizeReturnTo` (`worker/auth.js:180`)
  allows any same-origin path, so `/pro/<CODE>` survives sign-in.

**Analytics**
- No club event is sent server-side. The client events are `club_code_activated`,
  `club_code_rejected` and `club_left` (no `scope` yet), plus the ClubAdmin events.
- The catalogue is `docs/CLUBS.md:336-345`.

**Tests today**
- Worker unit tests:
  - `worker/club.test.js`: activate 112, state 283, leave 367, verifiedClubId 405,
    rotateClubCode 443.
  - `worker/club-admin-routes.test.js`: role 281, including "revoking a person marks every
    device linked to them" at 297, which this change reverses; device revoke 399.
  - `worker/session.test.js`, `worker/me.test.js`, `worker/gating.test.js`.
  - `worker/flags.test.js`: the gated-doors list is at 554-601; the declared-flags check is
    at 822.
- Client unit tests:
  - `packages/shared/__tests__/club.test.js`: refreshClub 234, leaveClub 526.
  - `UpgradeModal.test.jsx`: code entry 76, activated device 227.
  - `ZoomConnectionNotice.test.jsx` 298, `zoomIdentity.test.js`, `ClubAdmin.test.jsx` 119,
    `Account.test.jsx` 373.
- No Playwright spec covers joining, leaving or the console. `e2e/zoom.club-pro-gate.spec.js`
  shows how to seed `toastmaster_club` and mock `/api/zoom/session`.
- No Zoom-client spec covers `worker/club.js`, `UpgradeModal.jsx`, `ClubAdmin.jsx`,
  `ProActivate.jsx`, `ClubCodeSection.jsx` or `zoomIdentity.js`. Three specs cover
  `packages/shared/club.js`: `club-card-sets`, `club-pro-gate` and `club-renewal-reminder`.
  `club-card-sets` also covers `apps/zoom-app/src/main.jsx`, and its CC-03 step joins B
  with the code.

**Overlap**
- Open PR #145 (`fix/club-token-refresh-grace`) edits `worker/club.js`,
  `worker/club.test.js`, `packages/shared/club.js`, its test, `worker/auth.js` and three
  club specs. Whichever PR merges second rebases.

## Approach
The issue's design comment, points 1–9, is followed as written. Below is what each point
becomes in code, in the order the build would land it.

**Worker**
1. **Account index.** Add these to `worker/club-admin.js`:
   - `clubOfKey(uid)` = `club-of:zoom:<uid>`, holding `{ clubs: [{ id, at }] }`, newest
     first, capped at 10.
   - `addClubOf`, `removeClubOf` and `readClubOf`.

   It is a pointer only; readers re-check the member row and the club. Written on activate,
   create (`createClubFromPending` when `pending.uid` is set), restore and legacy link.
   Removed on "No access" and on Leave everywhere.
2. **Activate** (`handleClubActivate`): no session → `401 { error: 'sign_in_required' }`,
   checked after the throttle and before reading the code. A member with `revokedAt` →
   `invalid_code`.

   The old guest join stays behind a new release flag, `club_guest_join` (fallback `false`).
   This flag is **exempt from `FLAGS_FORCE`**: `flagOverride` skips keys in a
   `FORCE_EXEMPT` set, so dev tests the new rule. See Q1.

   `attachDevice` gains the member-revoked refusal, so `create` gets it as well.
3. **Revocation is read, not copied.**
   - `verifiedClubId`: when the device row has a `uid`, it also reads
     `club-member:<clubId>:zoom:<uid>` and refuses if `revokedAt` is set. That adds one KV
     read per club request from an identified device; guest rows don't pay it.
   - `handleClubState` refuses the same way, with 403 `club_access_revoked`.
   - Remove the cascade in `handleMemberRole` (357-368). The response keeps
     `devicesRevoked`, now the count of the person's devices affected, so the console
     confirm can name it.
4. **Restore**, `POST /api/club/restore { deviceId }`. It needs a session and joins
   `CLUB_DOORS`, so it is dark while `pro` is off.

   It walks the index, newest first, and takes the first club where all of these hold:
   - the club exists and `resolveAccess` says it is entitled;
   - the member row exists and is not revoked;
   - this device's row for that club is missing or not revoked.

   It then calls `attachDevice` with the same device id and answers like activate, plus
   `restored: true`. No match → `404 { error: 'no_club' }`. Index entries whose member row
   is gone are pruned along the way.
5. **`hasClub`.** One index read, true when the index has at least one entry. Added to:
   - the identified response of `/api/zoom/session` (`session.js:103-120`);
   - `/api/me`, when there is a uid (`me.js:52-61`).
6. **Leave everywhere.** `POST /api/club/leave { everywhere: true }` with a session:
   - deletes the member row and the person's unrevoked device rows;
   - removes the index entry and clears `club-admin-of`;
   - answers `{ left: true, devices: n }`.

   The last admin gets `409 last_admin`, reusing `activeAdmins`. Without `everywhere` the
   route behaves as today.

   `buildClubState` adds `myDevices`, the count of this uid's unrevoked rows, for the leave
   confirm. That is one prefix list per refresh, which happens at most daily.
7. **Legacy guest rows.** On `GET /api/club` with a session uid and a device row with no
   `uid`:
   - set the row's `uid`;
   - write the member row if it is missing, and add the index entry;
   - re-mint the token with the session uid.

   A row with a different uid is left alone; the club stays as the token says.
8. **Rotation.** `rotateClubCode` revokes uid-less device rows only. CLI help text is
   updated to match.

**Shared (`packages/shared/club.js`)**
9. `refreshClub` drops the club locally on 401/403/404 through a new `forgetClub()`. It no
   longer sends `/api/club/leave`, so an automatic drop never touches the server or the
   person. It records that the refresh was refused in this load (`clubRefusedThisLoad()`).
10. New `restoreClub({ getToken, trigger })`, which posts `/api/club/restore` with
    `clubDeviceId()`. On success it stores the club like `activateClub` does.

    A helper, `shouldRestoreClub({ hasClub })`, returns true when the account has a club and
    either nothing is cached or this load's refresh was refused.
11. `leaveClub({ everywhere, getToken })` sends `everywhere` and the Bearer when asked, and
    returns the server's answer (`devices`, or `last_admin`) before clearing local state.
12. `activateClub` passes through `sign_in_required`.
13. New `pendingClubCode` helpers: save, read and clear a typed code for 24 h, for the
    guest-mode fallback (AC-5).

**Zoom app**
14. `main.jsx`: in the `resolveZoomIdentity().then`, once identified, do the following in
    order:
    1. If a pending code is stored, activate it, then clear it.
    2. Otherwise, if `shouldRestoreClub(identity)`, call `restoreClub`.
    3. Fire `club_restored { surface: 'zoom', club_id, trigger: 'open' | 'refused' }`.

    `refreshClub` must have settled first: chain on its promise.
15. `zoomIdentity.js`: add `refreshZoomIdentity()`, which clears `identityPromise` and
    resolves again.
16. `UpgradeModal.jsx`:
    - **Guest mode** (`authStatus === 'authenticated'`): submitting a code shows "Approve
      Toastmusters Timer in Zoom to join your club" with an **Approve** button. That button
      calls `promptZoomAuthorize()`, then `refreshZoomIdentity()`.
      - If a uid comes back, the typed code is sent with no retyping.
      - If not, the code is stored as pending, and the join completes on the next
        identified open.
    - **Signed out** (`unauthenticated`): the modal shows "Sign in to the Zoom app, then
      open the timer again to join your club" and sends nothing.
    - Both cases fire `club_join_needs_signin { surface: 'zoom', auth_status }`.
    - The hint "No sign-in needed." is removed.
    - **Leave:** `window.confirm` names the device count ("Leave <club> on all N of your
      devices?"), then calls `leaveClub({ everywhere: true })`. It fires
      `club_left { …, scope: 'person' }`, or `scope: 'device'` for a guest device.
      `last_admin` shows the existing last-admin copy.
    - The joined copy changes from "This device is on Pro…" to "You're on Pro through
      <club>".
17. `ZoomConnectionNotice.jsx`: no behaviour change. The approve flow is reused through
    `promptZoomAuthorize`. Its spec is not affected.

**Web**
18. `main.jsx`: after `startWebSession` resolves with a uid, restore the same way as the
    Zoom app, firing `club_restored` with `surface: 'web'`.
19. `ProActivate.jsx`:
    - **Signed out:** show "Sign in with Zoom to join" with
      `signInUrl('/pro/<CODE>')`, and fire `club_join_needs_signin`.
    - **Signed in:** activate as today. The success page drops the "enter this code in Zoom"
      box and says "Open Toastmusters Timer in Zoom with the same account; it joins by
      itself."
20. `ClubCodeSection.jsx`:
    - **Signed out:** show "Sign in with Zoom to join" (`signInUrl('/account')`) instead of
      the code field.
    - **Leave:** confirm with the device count, then `everywhere: true`.
    - The "No sign-in needed" and "enter the same code" copy goes.
21. `ClubAdmin.jsx`:
    - The "No access" choice confirms with the person's device count ("Turn off access for
      <name> on N devices?").
    - A note under the device list: "Revoking a device blocks that device. If it is still
      signed in to the person's Zoom account, choose No access for the person instead."
    - Guest devices keep their section.

**Docs**
22. `docs/CLUBS.md`: the membership model, the new endpoints and events, and rotation.

**Rejected options**
- Scanning `club-member:*` instead of an index: a KV list over every club on every open.
- Copying revocation onto devices, as today: a restored person's devices stay dead (AC-4).
- Keeping guest joins on: signed-out users can't be restored, and they reopen the hole.
- A plain `club_guest_join` flag without the `FLAGS_FORCE` exemption: dev would never test
  the new rule.
- One PR per surface: the worker refuses guest joins, so the clients have to ship the
  sign-in copy in the same release. Q5 offers a split.

## Acceptance criteria
These are the issue's criteria, unchanged, plus AC-13 from the flag finding.
- AC-1: Given an identified Zoom user enters a valid code, when they then open the timer on
  a second computer signed in to the same Zoom account, then that computer joins the club
  with no code entered, and the club console lists one person with two devices.
- AC-2: Given a member's device whose club was dropped (refresh refused with 401, or storage
  cleared), when the timer next opens with that Zoom account, then it rejoins without the
  code, and the console shows the same device row, not a new one.
- AC-3: Given an admin revoked one device, when that device opens the timer with the
  member's Zoom account, then it does not rejoin, and the member's other devices keep
  working.
- AC-4: Given an admin set a person to "No access", when any of their devices opens the
  timer, restores, or enters the code on a new device, then they are refused
  (`invalid_code` for the code). When the admin gives the person a role again, then their
  devices work again without the code, except devices revoked one by one.
- AC-5: Given a Zoom user in guest mode (signed in, app not approved) enters a code, then
  they see "Approve Toastmusters Timer in Zoom to join your club" with an Approve button,
  and after approving in Zoom's prompt the join completes with no need to enter the code
  again. If Zoom gives no identity until the app reloads, the join completes on the next
  open.
- AC-6: Given a Zoom user signed out of Zoom enters a code, then nothing joins, they see
  "Sign in to the Zoom app, then open the timer again to join your club", and the free
  timer keeps working. `POST /api/club/activate` with no session answers
  `401 sign_in_required` before it reads the code.
- AC-7: Given a signed-out browser opens `/pro/<CODE>` or enters a code on the Account page,
  then it shows "Sign in with Zoom to join". After signing in it returns to `/pro/<CODE>`
  and joins, the success page no longer asks the visitor to enter the code in Zoom, and
  opening the Zoom app with the same account joins the club with no code.
- AC-8: Given an identified member chooses Leave in the Zoom app or on the web, then the
  confirm names how many devices are affected, and after confirming, the person leaves on
  all their devices: the console no longer lists them and none of their devices rejoins on
  open. The last admin is refused with the existing last-admin message. A club dropped
  automatically after a refused refresh never removes the person.
- AC-9: Given a device that joined as a guest before this change (no Zoom identity on its
  row), when it opens identified, then it keeps working and the console moves it under that
  person.
- AC-10: Given one Zoom account signed in on two computers, then the console shows one
  person with two devices. Revoking one leaves the other working. A different Zoom account
  opening one of those computers does not become a member.
- AC-11: Given the club code is rotated with the CLI, then the old code admits nobody, guest
  devices are revoked, and members' devices keep working.
- AC-12: PostHog receives `club_restored` (`surface`, `club_id`, `trigger`),
  `club_join_needs_signin` (`surface`, `auth_status`), and `club_left` with
  `scope: person|device`.
- AC-13 (proposed): Given `FLAGS_FORCE="1"` (dev), when a request with no session activates
  a code, then it is refused with `401 sign_in_required`. `club_guest_join` is decided by
  PostHog or its fallback only.

## Test list
| AC | Unit (vitest) | Playwright | Zoom-client spec (`club-membership`, NEW) |
|---|---|---|---|
| AC-1 | `worker/club.test.js`: activate writes `club-of`; restore attaches a new device. `club-admin-routes.test.js`: roster shows one person, two devices | NEW `e2e/web.club-membership.spec.js`: mocked `/api/me` `hasClub`, then restore, then "You're on Pro through" | CM-01 join with the code on A (Zoom); CM-02 B (web, same account) joins with no code; console shows 1 person, 2 devices |
| AC-2 | `club.test.js`: restore reuses the device row (same `activatedAt`). `packages/shared/__tests__/club.test.js`: 401 refresh drops locally, sends no leave, `shouldRestoreClub` is true | spec above: refused refresh, then restore | CM-03 clear A's club storage (DevTools) or wait for a refused refresh; reopen; same row in the console |
| AC-3 | `club.test.js`: restore refuses a revoked device row (404 `no_club`) and leaves other devices working | — | CM-04 revoke B in the console; B reopens and stays free; A keeps the club |
| AC-4 | `club.test.js`: activate refuses a revoked member (`invalid_code`); restore and `verifiedClubId` refuse; `GET /api/club` 403. `club-admin-routes.test.js`: "No access" leaves device rows untouched; giving the role back restores all but the one-by-one revoked rows (replaces the test at 297) | — | CM-05 "No access" on the person (confirm names N devices); A and B lose the club; give the role back; A works without the code, B (revoked) does not |
| AC-5 | `UpgradeModal.test.jsx`: guest submit shows the Approve copy; approve → `refreshZoomIdentity` → activate with the typed code; no uid → pending code. `zoomIdentity.test.js`: `refreshZoomIdentity` resolves again. Shared: pending code expires after 24 h | — | CM-06 (human) Zoom guest mode: enter the code, approve in Zoom's prompt, joins |
| AC-6 | `club.test.js`: no session → 401 `sign_in_required` before the code lookup (no `club-by-code` read). `UpgradeModal.test.jsx`: `unauthenticated` copy, no fetch | NEW zoom spec: mocked unauthenticated session, code entry shows the sign-in copy, timer starts | CM-07 (human) signed out of Zoom: the copy shows; the free timer runs |
| AC-7 | NEW `ProActivate.test.jsx`, NEW `ClubCodeSection.test.jsx`: signed-out copy and the `signInUrl` return path; success copy | spec above: `/pro/<CODE>` signed out shows the button with `returnTo=%2Fpro%2F<CODE>` | CM-08 signed-out browser `/pro/<CODE>`, sign in, returns and joins; then CM-02's restore in Zoom |
| AC-8 | `club.test.js`: `everywhere` deletes the member, unrevoked devices and the index; `last_admin` 409; no `everywhere` = today. Shared: `leaveClub({everywhere})`. `UpgradeModal.test.jsx` and `ClubCodeSection.test.jsx`: confirm names N | — | CM-09 Leave on A (confirm says 2 devices); console drops the person; A and B reopen free |
| AC-9 | `club.test.js`: `GET /api/club` with a session links a uid-less row, writes member and index, and re-mints with the uid; a row with another uid is left alone | — | CM-10 web as a guest device (seeded with `FLAGS_FORCE` and `club_guest_join` via CLI or KV), then sign in; console moves it |
| AC-10 | `club.test.js`: restore for uid X never attaches for uid Y; roster groups per uid | — | CM-11 (human) another Zoom account opens A: no club |
| AC-11 | `club.test.js` `rotateClubCode`: only uid-less rows revoked; old code `invalid_code` | — | CM-12 rotate with `scripts/club-cli.mjs` on dev; A keeps the club; the old code is refused |
| AC-12 | `UpgradeModal.test.jsx`, `main` restore helper test, web page tests assert event names and properties | — | CM-13 PostHog shows `club_restored`, `club_join_needs_signin`, `club_left{scope}` from the run |
| AC-13 | `worker/flags.test.js`: `FLAGS_FORCE="1"` leaves `club_guest_join` false; gated-doors list gains `POST /api/club/restore` | — | covered by CM-07 on dev |

Also update `worker/session.test.js` and `worker/me.test.js` (`hasClub`) and
`worker/gating.test.js` (member-revoked device refused).

Specs:
- Add `e2e/zoom-client/club-membership.md` from `_template.md`, and list it in `INDEX.md`.
- Its `covers`: `worker/club.js`, `worker/club-admin.js`, `worker/club-admin-routes.js`,
  `apps/zoom-app/src/components/UpgradeModal.jsx`, `apps/zoom-app/src/utils/zoomIdentity.js`,
  `apps/web/src/pages/ProActivate.jsx`, `apps/web/src/components/ClubCodeSection.jsx`,
  `apps/web/src/pages/ClubAdmin.jsx`.
- Review for drift, step IDs unchanged:
  - `club-card-sets` (covers `packages/shared/club.js` and `main.jsx`): CC-03 joins B with
    the code, and now needs B signed in, or joins by restore.
  - `club-pro-gate` and `club-renewal-reminder`: no step changes are expected.

## Risk
**high.** It changes who may join a club, how revocation works, and the entitlement every
club feature checks.
- `riskHigh` paths touched:
  - `worker/session.js` (`hasClub`);
  - `worker/flags.js` (the new flag and the `FORCE_EXEMPT` set);
  - `worker/auth.js` only if `readSession` needs a helper. The plan doesn't expect one.
- Every club request from an identified device pays one extra KV read in `verifiedClubId`.
- PR #145 edits the same files (`worker/club.js`, `packages/shared/club.js`, their tests and
  three club specs). The second PR to merge has to rebase.
- Production has no clubs and `pro` is off, so nobody in production sees this until `pro`
  goes on.

## Open questions
- Q1: Keep the guest-join flag? Default: **keep**, as `club_guest_join` with fallback
  `false`, **exempt from `FLAGS_FORCE`**. Otherwise `FLAGS_FORCE="1"` would turn guest join
  back on on dev and the new rule could not be tested there (AC-13, proposed). The
  alternative is to drop the flag, since production has no clubs and a revert is a deploy.
- Q2: Leave covers all of a member's devices, with no device-only leave? Default: **all
  devices**. A guest device's leave stays device-only.
- Q3: Show Zoom display names in the roster? Default: **no** (out of scope; the
  admin-typed nickname stays).
- Q4: Ship before `pro` goes on? Default: **yes**.
- Q5: One PR, or split into worker (restore, index, revocation, rotation) and then clients?
  Default: **one PR**, because refusing guest joins without the sign-in copy would show
  "That code isn't active" to guests.
- Q6: The joined copy changes from "This device is on Pro through <club>" to "You're on Pro
  through <club>" (Zoom) and "You're on Pro through your club" (web). Default: **change it**,
  wording as written.
- Q7: AC-13 is new (proposed) and comes from the `FLAGS_FORCE` finding. Default: **include
  it**.
