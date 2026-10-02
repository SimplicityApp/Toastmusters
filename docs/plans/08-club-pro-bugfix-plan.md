---
task: define-pro-features-plan-with-code-call-stacks-6t488q
type: bugfix-plan
source: test-runs/2026-09-28-club-pro/run.md (automated Zoom + web run on dev, version 4f6555f5)
branch: dev
---

# Club Pro — bug fix plan from the 2026-09-28 test run

Seven fixes, in the order they should ship. Each lists the evidence from the
run, the cause as traced in code, the change, and how to prove it.

Out of scope (user decisions): Zoom's background dialogs (expected), the PostHog
club survey after FINISH (intended), rate-limit copy, the early renewal banner.

| # | Bug | Severity | Size |
|---|---|---|---|
| 1 | Console rejects a signed-in admin (401) | High — *Manage your club* is dead for Zoom-only officers | M |
| 2 | Speech upload at FINISH can strand in the outbox | High — archive and other devices miss speeches | M |
| 3 | Share text and preview image under-count the meeting | Medium | S |
| 4 | Sharing a second time 404s | Medium | S |
| 5 | Duplicate device rows; admin shown as a raw uid | Medium | M |
| 6 | Badge truncates to "C…"; no badge on the web full-screen card | Medium | S |
| 7 | Dev web "Add to Zoom" installs the production app | Low (dev only) | XS |
| — | Zoom "Untrusted Web Site" on *Manage your club* | Config, no code | — |

---

## 1. Console Zoom door requires the club code in the same browser

**Evidence.** Chrome signed in with Zoom (`/api/me` 200) → `/club/admin` →
`GET /api/club/roster` **401**. Worked only after opening `/pro/<code>` in that
browser. *Manage your club* opens the system browser, which never has the code.

**Cause.** `readAdminContext` (`worker/club-admin-routes.js:84`) only builds the
Zoom actor when *both* `X-Club` claims and a session uid are present; with no
club token there is no clubId to look the uid up in, so it returns null → 401.
There is no uid → club index: member rows are `club-member:<clubId>:zoom:<uid>`,
keyed club-first.

**Fix.**
1. New reverse index `club-admin-of:zoom:<uid>` → `clubId`, written wherever an
   admin row is written: `createClubFromPending` (`worker/club-admin.js:252`) and
   the role route (`club-admin-routes.js` ~`:319`) on promote; deleted on demote
   or revoke.
2. `readAdminContext`: if there is a session uid but no `X-Club`, read the index,
   then **re-verify** with `readMemberRole(env, clubId, uid) === 'admin'` (the
   index is a pointer, the member row stays the authority).
3. Backfill: one pass in `scripts/club-cli.mjs` (`backfill-admin-index`) over
   `club-member:*` rows with role admin. Dev has one club; prod has none yet.
4. Console: when the admin arrives with no club token, don't activate the device
   — the console is about the person, not the device (per the comment at
   `club-admin-routes.js:73`).

**Tests.** Session-only request → 200 for an admin; → 403 for a demoted admin
whose stale index still points at the club; → 401 with neither credential.

---

## 2. Speech upload at FINISH can strand in the outbox

**What "upload" is.** FINISH writes the speech to the device's own report *and*
queues a copy in `localStorage.toastmaster_club_outbox`. `drainOutbox`
(`packages/shared/clubArchive.js:299`) sends each queued speech to
`POST /api/club/meetings/<date>/speeches`. The server copy is the club's
archive: other devices' **History**, the **/r/ share page**, and the report
header all read it. A speech that never leaves the outbox exists only on the
device that timed it.

**Evidence.** 2 of 3 FINISH uploads stayed queued ("1 speech waiting to
upload") while online — Zoom A and the web — and went out only on the next app
start. Replaying the queued entry by hand from the same page: 200 in 431 ms.
Across the 2026-09-28/29 runs (`test-runs/2026-09-29-skill-smoke/run.md`), every
failure was on a page that **loaded with an empty outbox**, and every success on
a page that loaded with a speech already queued. The first theory — the first
upload after the Mac woke from a 2-hour sleep — was a coincidence: those pages
had also loaded clean.

**Cause (confirmed in the deployed bundle).** A synchronous-completion ordering
bug in `drainOutbox`:

    if (draining) return draining;
    draining = (async () => { try { loop } finally { draining = null } ... })();

A drain with nothing to await (empty queue, or no club token) runs the async
function to completion *synchronously*: `finally { draining = null }` runs
first, and only then does the assignment store the already-settled promise in
`draining`. Nothing clears it again, so every later `drainOutbox()` returns that
stale promise and does nothing — the one inside `recordSpeech` at FINISH, the
backoff timer, and the `online` / `visibilitychange` wake triggers alike. App
start (`apps/web/src/main.jsx`, `apps/zoom-app/src/main.jsx`) drains an empty
outbox on every clean load, so it triggers on every clean load. When the page
loaded with a speech queued, the start-up drain awaited a fetch, `finally` ran
after the assignment, and the flag cleared normally.

**Real fix (follow-up to PR #74).** Assign first, then clear only if still
current: `const run = (async () => {...})(); draining = run;
run.then(release, release)` where `release` nulls `draining` only when
`draining === run`. Same identity guard added to `warmClubLogo`'s
`logoPending`. Regression tests: an empty-outbox drain, then `recordSpeech`
uploads; the same with no club token at first; and after that first drain the
`online` event and the backoff timer still drain.

**Defence in depth (PR #74, kept).** Not the cause, but still worth having. Before
the real fix none of it ever ran, because every trigger returned the stale promise:
- `uploadOne` calls `fetch` with **no timeout**. A request that never answers
  would hold `draining` for ever.
- If the request throws, the loop `break`s and **nothing schedules a retry**:
  the only triggers are app start and the next FINISH.

**Fix (PR #74).**
1. `AbortController` timeout (10 s) in `uploadOne`; treat abort as retryable.
2. Retry triggers while `outboxPending()`: `online` event, `visibilitychange` →
   visible, and a backoff timer (15 s → 30 s → 60 s → 5 min cap). Clear the timer
   when the outbox empties.
3. `endMeetingAndShare` awaits the drain **with a deadline** (e.g. 8 s) so a hung
   drain cannot freeze the share button.
4. PostHog `club_upload_failed { reason: timeout|network|http_5xx, pending }`
   so we see this in production rather than in a test run.

**Tests.** `fetchImpl` that never resolves → aborts at 10 s, entry kept, a later
drain succeeds (was: hangs forever). `fetchImpl` that throws once → backoff timer
re-drains without a FINISH. `online` event → drain. Share completes while a
drain is hung.

---

## 3. Share text and preview image under-count the meeting

**Evidence.** Meeting `20260928` held 3 speeches from two devices. The web share
card said "2 speeches, 1 over time"; the OG image (`r-og.png`) listed only this
device's 2. The server page `/r/FWE9XCAAXJ0FPR7C` correctly said 3 · 2 over time.

**Cause.** `endMeetingAndShare` (`clubArchive.js:485`) renders both PNGs and
counts from `speeches` — the caller passes the device's local `reports`
(`ReportTab.jsx:56`).

**Fix.** After the drain, `fetchMeeting(id)` and use the server's speeches for
the counts and both PNGs; fall back to local rows only if the fetch fails (the
offline "Copy image" case the function already promises).

**Test.** Two devices, one meeting: the share from either device reports the
combined count and the PNG lists every speech.

---

## 4. Sharing a second time 404s

**Evidence.** Second *End meeting & share* on the same report →
`POST /api/club/meetings/20260928-2/share` **404**; UI "The link could not be
created just now", WhatsApp/Copy link disabled, title lost.

**Cause.** After a successful share, `startNewMeeting()` advances the day's
sequence (`clubArchive.js` end of `endMeetingAndShare`), but the local report
still shows the ended meeting's speeches. The next share derives the *new* id,
which has no speeches.

**Fix.** Persist `toastmaster_club_last_share = { meetingId, url, token, title,
speechIds }` on success. On the next share, if every local row's `speechId` is
already in `last_share.speechIds` (nothing new was timed), share
`last_share.meetingId` again — the server returns the same token — and reopen
the card with the stored title. If new speeches exist, use the new meeting as
today.

**Test.** Share → close → share again with no new speech → same URL/token;
share after a new speech → new meeting id.

---

## 5. Duplicate device rows; admin shown as a raw uid

**Evidence.** Roster: "4 devices · 1 person"; the admin had Chrome + **two**
"macOS" rows for the same Zoom client; the person row read
`jQU-jzp5QXqt2VAOlw8xhg`.

**Cause.**
- `attachDevice` (`worker/club.js:293`) mints `crypto.randomUUID()` on every
  activate/create. `leaveClub()` (`packages/shared/club.js:792`) forgets the token
  locally but never tells the server, so each leave + rejoin adds a row.
- `displayName` is written `null` everywhere (`club.js:313`,
  `club-admin.js:252`) and nothing ever sets it; `ClubAdmin.jsx:123` falls back
  to the uid.

**Fix.**
1. Stable device id: the client keeps `toastmaster_device_id` (random, survives
   `leaveClub`) and sends it on activate/create. `attachDevice` reuses
   `club-device:<clubId>:<deviceId>` when it exists and is not revoked (update
   `lastSeenAt`, `uid`), and refuses to un-revoke a revoked one.
2. `POST /api/club/leave` (X-Club): deletes this device's row. `leaveClub()`
   calls it fire-and-forget.
3. Names without new PII scope: the console shows **"You"** for the signed-in
   viewer's own uid, and lets an admin set a **nickname** per member
   (`POST /api/club/members/<uid>/name`, stored as `displayName`). Capturing
   Zoom's `screenName` automatically is possible via `getUserContext`, but it is
   new personal data and needs a privacy-policy line — decide separately.
4. One-off cleanup on dev: delete the stale device rows for club
   `38f0a15b-…` (CLI `prune-devices --club`).

**Tests.** Leave + rejoin → still one row; revoked device rejoining stays
revoked; roster shows "You" and nicknames.

---

## 6. Badge truncates to "C…"; no badge on the web full-screen card

**Evidence.** Zoom preview, no logo: "C…". Web panel preview: "Claude …"
overhanging the tile. Web full-screen card (panel minimised): no badge at any
colour. The **video overlay** showed the full "Claude Test Club" correctly.

**Cause.**
- `ClubBadge` caps width at `maxWidth: '44%'` of its container but sizes height
  and font in `cqh` (`packages/ui/ClubBadge.jsx:96`). The canvas renderer applies
  44% to a **16:9** frame; the previews are a portrait panel and a *square* tile
  (`apps/web/src/components/TimerDisplay.jsx:20`, `aspect-square`), so the same
  font gets less than half the width.
- The web full-screen card is only `document.body` background
  (`apps/web/src/utils/pageBackground.js:21`); no component draws a badge there.

**Fix.**
1. Cap width against the frame the badge will actually land on:
   `maxWidth: calc(44 * 16 / 9 * 1cqh)` (44% of a 16:9 frame of that height),
   so previews match the video; keep `truncate` as the last resort.
2. In `TimerApp.jsx`, render a fixed full-viewport `ClubBadgeLayer` + `ClubBadge`
   when the panel is minimised and `clubKit.showOnCards`.

**Tests.** Visual/DOM test: a 16-character name fits in the square tile and the
Zoom preview; the full-screen layer renders only with `showOnCards`.

---

## 7. Dev web "Add to Zoom" installs the production app

**Evidence.** Dev `/app` footer: `client_id=DsFHK5sNQs2_VFyeQky2sg`, redirect
`www.timer.simple-tech.app` (production).

**Cause.** The web app reads build-time `VITE_ZOOM_OAUTH_REDIRECT`
(`Footer.jsx:14`, `Landing.jsx:505`, `ReviewPromptModal.jsx:11`) from the root
`.env`, which holds the production link, and `cf:deploy:dev` builds with it.

**Fix (one line).** Set the dev link in the dev build — Vite lets an existing
process env var win over `.env`:

```json
"cf:deploy:dev": "VITE_ZOOM_OAUTH_REDIRECT='https://zoom.us/oauth/authorize?response_type=code&client_id=kgpoX2A6TY2BvdctzK9iw&redirect_uri=https://www.timer-dev.simple-tech.app/oauth/redirect' npm run build && wrangler deploy --env dev"
```

Same pattern `cf:deploy:tabletopics:dev` already uses for `SITE_ORIGIN`. If a
previous attempt "didn't take", the likely reason is that it was put in a `.env`
file (lower priority) rather than the command's environment. Verify with
`curl -s https://www.timer-dev.simple-tech.app/app | grep -o 'client_id=[^&"]*'`
after deploy.

---

## Config: Zoom "Accessing Untrusted Web Site"

**Where it appeared.** Zoom app → footer **Pro** → **Manage your club**. Zoom
opened Chrome at `https://marketplace.zoom.us/z/<token>` titled *Accessing
Untrusted Site*: "This web site at www.timer-dev.simple-tech.app does not belong
to a domain trusted by Zoom App Marketplace", with the target
`https://www.timer-dev.simple-tech.app/club/admin` as a link below.

**Why you may not see it.** It appears only for hosts missing from the app's
*Domain Allow List*. The button targets `WEB_ORIGIN` (`simple-tech.app` on dev);
if your allow list has `toastmusters.com` hosts but not `simple-tech.app`, or you
tested on prod, you would not hit it.

**Action.** Marketplace → dev app → *Features → Surface → Domain Allow List*:
confirm `www.timer-dev.simple-tech.app` is listed (and prod lists
`www.timer.simple-tech.app` / `www.timer.toastmusters.com`). No code change.

---

## Order and verification

1. **#2 upload** and **#1 console** — the two that lose data or lock officers out.
2. **#3 + #4 share** together — same function, one PR.
3. **#5 devices/names**, **#6 badge**.
4. **#7** whenever convenient (one line).

After each deploy, re-run the matching steps from
`06-zoom-client-test-plan-club-pro.md` with the automation in
`test-runs/`: 21 (console via *Manage your club*), 15–17 (upload, restart,
offline), 18–20 (two devices, share twice), 9.4/10 (badge), and the roster.
