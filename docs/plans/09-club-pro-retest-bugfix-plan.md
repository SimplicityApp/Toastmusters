---
task: define-pro-features-plan-with-code-call-stacks-6t488q
type: bugfix-plan
source: test-runs/2026-09-29-club-pro-retest/run.md (automated Zoom + web re-test on dev, version ed97d81d)
branch: dev (origin/dev 958f33b — PR #74 + #75)
follows: docs/plans/08-club-pro-bugfix-plan.md
---

# Club Pro — bug fix plan from the 2026-09-29 re-test

The re-test confirmed 08's #1, #2, #4, #5 and #7. Nothing that passed before
regressed. This plan covers what is still broken, plus what the re-test found.
Each item lists the evidence from `run.md`, the cause as traced in
`origin/dev`, the change, and the test that proves it.

Out of scope (user rulings): Zoom's background dialogs, the PostHog club
survey, the "Too many tries…" copy, the early renewal banner.

| # | Bug | Severity | Size |
|---|---|---|---|
| 1 | Revoked device drops FINISH silently and shows "Saved to …" | **High** — data loss with a false success | M |
| 2 | Share card, text and OG image over-count (08 #3 regressed the other way) | High — the shared link is what the club sees | S |
| 3 | Badge overruns or truncates on previews and in stage mode (08 #6 partial) | Medium | M |
| 4 | Revoked device can re-activate and is told it is on Pro | Medium | S |
| 5 | A device keeps appending to a meeting another device has ended and shared | Medium | M |
| 6 | Hiding the badge moves Reset under the cursor | Low | XS |
| 7 | `online` wake is ignored while the tab is hidden | Low | XS |
| 8 | Revoked rows can never leave the roster | Low | S |
| 9 | Dev "Open in Zoom" and the no-JS shell still point at the prod app | Low (dev only) | XS |
| 10 | Small UI and API nits | Low | XS each |
| — | Zoom "Untrusted Web Site" on *Manage your club* (08 Config, still shown) | Config, no code | — |

---

## 1. Revoked device drops FINISH silently and shows "Saved to …"

**Evidence.** Zoom A was revoked, reloaded with ⋯ → Refresh app, then FINISH
00:22 at 19:59:54 UTC →
`POST /api/club/meetings/20260929/speeches` **403**. `GET /api/club/meetings/20260929`
has no such row. The REPORT strip read **"✓ Saved to Claude Test Club"**
(`shots/160014-a2-revoked-report.png`). The local Report row stays, so a later
share merges it back in (see #2).

**Cause.** In `drainOutbox` (`packages/shared/clubArchive.js`, the loop after
`uploadOne`), only a thrown fetch and a 5xx keep the entry. *Any* other status
is "done travelling": the entry leaves the outbox and nothing is reported.
The strip in both `ReportTab.jsx` files is outbox depth only
(`useClub.js:25`), so an empty outbox reads as saved. The same path swallows
402 (lapsed club), 401 and 403 `not_a_member`.

**Fix.**
1. Split the non-OK branch:
   - `2xx` → drop the entry, count it as sent (as today).
   - `401 / 402 / 403` → move the entry to a new `toastmaster_club_rejected`
     list, together with `{status, error, at}`. Call
     `reportFailure('rejected', {status, error})` (PostHog `club_upload_failed`
     with reason `rejected_<status>`).
   - `400 / 404 / 409 / 413 / 422` → drop the entry, but still report it. The
     server will never accept that body.
2. `subscribeOutbox` also publishes the rejected count. The strip shows, in
   priority order:
   1. "1 speech not saved — this device was removed from Claude Test Club"
      (403 `club_access_revoked`)
   2. "…the club's Pro has ended" (402)
   3. "N waiting to upload"
   4. "Saved to …"

   Keep the local report row either way. It is the only copy left.
3. On a 403 `club_access_revoked`, call `refreshClub({ force: true })`. The
   daily refresh already turns that 403 into a revoked state. See #4.3 for
   what the UI does with it.

**Tests** (`packages/shared/__tests__/clubArchive.test.js`):
- a 403 upload leaves the outbox empty, puts the entry in `rejected`, and
  reports once;
- the strip state is `rejected`, not `saved`;
- a 402 behaves the same;
- a 400 is dropped and reported, and is not kept in `rejected`.

**Re-test.** Revoke Zoom A in the console. ⋯ → Refresh app. FINISH. Expect the
tail to show 403, the strip to name the problem, and no "Saved to".

---

## 2. Share card, text and OG image over-count

**Evidence.**
- Chrome shared meeting `20260929` ("Retest share A"). The card, the text and
  `r-og-A.png` said **13 speeches · 1 over time**. The server held **11**
  speeches, 0 over time, and `/r/TW3WQZYWF3RG8YWM` correctly said 11.
- The two extra rows were `8ebcea65` (01:03 red) and `a0161d64` (00:19). They
  belong to meeting **20260928** and were still on Chrome's Report tab.
- Meeting `20260929-2` held 1 speech, but its share said **9** and the PNG
  listed meeting 1's speeches (`r-og-B.png`).

**Cause.** 08 #3 added `wholeMeeting(id, rows)` (`clubArchive.js` ~l.851).
Once the server read succeeds, it unions the server's speeches with **every
local row whose speechId the server lacks**. The caller passes the whole
Report tab (`apps/*/src/components/ReportTab.jsx`,
`endMeetingAndShare({ speeches: reports })`), and that tab spans meetings and
days. Report rows carry no `meetingId` (`TimerContext.jsx` `addReport` →
`recordSpeech`, which derives the id only for the outbox entry), so there is
nothing to filter on.

**Fix.**
1. Stamp `meetingId` on the report row at FINISH. Derive it once in
   `finishCurrentSpeech` (both `TimerContext.jsx`) and pass it to both
   `addReport` and `recordSpeech`, so the two can never disagree.
2. `wholeMeeting`: when the server read succeeds, return the server's rows plus
   only the local rows that are **still in the outbox for this meetingId**, i.e.
   genuinely in flight. A local row the server lacks for any other reason is
   either another meeting or a refused upload (#1). Neither belongs on the share.
3. Offline fallback (server read failed): use local rows with
   `meetingId === id`. Legacy rows with no `meetingId` count only when no row
   has one.
4. `isRepeatShare`: compare against this meeting's rows only.

**Tests.**
- Server has 11 rows, local has 13 (2 from yesterday) → 11.
- A second meeting on the same device → only its own row.
- A row in the outbox for this meeting is counted once.
- A rejected row (#1) is not counted.
- Offline → local rows of this meeting only.

**Re-test.** Repeat run.md 16:11 and 16:12. The card, text, OG PNG and `/r/`
must all agree.

---

## 3. Badge overruns or truncates on previews and in stage mode

**Evidence.**
- **Zoom panel preview**, name-only kit: badge reads **"Claude Tes…"**, and
  "Claude …" when scaled up. It overhangs the tile's right edge
  (`162429-a6z-nameonly-preview.png`).
- **Web square tile**: the text fits, but the pill overhangs by 30 px (51 px
  with the logo, clipped to "Claude Test Clu").
- **Stage mode (Full-Screen Timer)**: the badge is about half the panel wide,
  runs off the right edge, and sits under Zoom's Screenshare and pop-out
  buttons (`163630-c12-stage-panel.png`).
- The **video** renders the full name correctly in camera and card modes.

**Cause.**
1. `ClubBadge.jsx` has no edge clamp. The DOM badge is centred at
   `left: x%` with `translate(-50%)` and a `maxWidth` of `78.22cqh`. At the
   default `x = 0.8`, a badge wider than 40% of the container runs past the
   right edge. The canvas renderer (`clubBadge.js drawClubBadge`) clamps the
   centre so the whole badge sits inside a 4% inset. The DOM badge never got
   that clamp, which is why the video is right and every preview is wrong.
2. Different fonts. Canvas measures with `bold 'Helvetica Neue', Helvetica`,
   while the DOM badge inherits the app font (Plus Jakarta / Inter bold), which
   is wider. The same name therefore ellipsizes earlier in the DOM.
3. Stage mode puts `ClubBadgeLayer` on the full `fixed inset-0` stage
   (`TimerStage.jsx` ~l.130). The card artwork is drawn `contain` inside it, a
   16:9 box letterboxed in a taller panel. So `cqh` resolves against the
   panel's height, not the artwork's, and the badge is sized for a much bigger
   frame. The header row (speaker name, Screenshare, pop-out, ✕) paints on top
   of the badge's top-right spot.

**Fix.**
1. `ClubBadge`: port the canvas clamp. Wrap the badge in a positioned box and
   clamp its centre with CSS:
   `left: clamp(calc(4cqh + W/2), x·100cqw, calc(100cqw - 4cqh - W/2))`.
   `W` isn't known in CSS, so measure it: after layout, a `ResizeObserver`
   reads the badge width and sets `--badge-w`. Also cap
   `maxWidth: min(78.22cqh, 100cqw - 8cqh)`.
2. Give the DOM badge the canvas font stack
   (`'Helvetica Neue', Helvetica, Arial, sans-serif`, bold), so DOM and canvas
   ellipsize at the same point.
3. `TimerStage`: render the badge inside a box that matches the artwork's
   contained 16:9 rectangle (`aspect-ratio: 16/9`, `max-width: 100%`,
   `max-height: 100%`, centred), with `ClubBadgeLayer` in that box. Keep the
   header controls on a higher `z-index`, and add a top inset so the default
   top-right spot clears the control row.
4. Fix the comment above `MAX_WIDTH_OF_HEIGHT`. "Every surface … is square or
   wider" is true of the tiles but not of the stage panel, and a centred
   badge can still overrun even a square.

**Tests** (DOM, `packages/ui/__tests__`):
- A 16-character name at the default placement stays inside a 280×280 tile
  and a 448×448 tile.
- At `x = 0.98` the badge's right edge is ≤ container width − 4% of height.
- In stage mode the badge lies inside the 16:9 box.

**Re-test.** run.md 16:24 (Zoom preview), 15:47 (web tile) and 16:36 (stage).
Expect the full "Claude Test Club" in all three, with nothing over the edge.

---

## 4. Revoked device can re-activate and is told it is on Pro

**Evidence.**
- Guest `dabbaf3a` was revoked, then went Leave → re-enter code →
  `POST /api/club/activate` **200** with a token. `/account` said "This
  browser is on Pro through your club". Its first `GET /api/club` returned
  **403** `club_access_revoked`.
- Chrome, revoked at 19:00, still showed the club, badge and banner at 19:40,
  because no refresh is due for 24 h.

**Cause.** `attachDevice` (`worker/club.js` ~l.305) carries `revokedAt`
forward correctly. But `handleClubActivate` / `handleClubCreate` still sign and
return a token plus the full club state. Only later requests check
`device.revokedAt`. On the client, `refreshClub` runs once a day
(`CLUB_REFRESH_INTERVAL_MS`), and nothing else checks.

**Fix.**
1. Worker: in both activate and create, when the reused device row is
   revoked, return `403 { error: 'club_access_revoked', club: { name } }` with
   no token.
2. Clients (`ClubCodeSection.jsx`, Zoom `UpgradeModal.jsx`): map that error to
   "This device was removed from <club>. Ask your club admin to restore it."
3. Add a local `revoked` state: `refreshClub` sets it on a 403
   `club_access_revoked`. Treat the device as not in a club (no badge, no club
   presets, no "Saved to"), and show a one-line banner with the club's name.
   #1.3 triggers this refresh on the first refused upload, so a revoked device
   finds out at its next FINISH instead of up to 24 h later.

**Tests.**
- Worker: activating a revoked row returns 403 with no token, and the row is
  unchanged.
- Client: a 403 on refresh gives the revoked state and hides the badge.

---

## 5. A device keeps appending to a meeting another device has ended

**Evidence.**
- Chrome ended and shared `20260929` at 20:09, and its own sequence moved to
  `-2`.
- Zoom A, which never shared, kept filing under `20260929` (20:28:17, 20:35:06,
  20:40:16, all 200).
- `/r/TW3WQZYWF3RG8YWM` ("Retest share A") now shows speeches timed after it
  was shared.

**Cause.** The meeting sequence is per device (`toastmaster_meeting_seq`,
advanced by `startNewMeeting` after a device's own successful share). The
server accepts appends to any meeting id, and `live` in the meeting list
(`worker/club-meetings.js` ~l.325) is just "has pending speeches". Nothing
records that a meeting was ended.

**Fix.**
1. Server: the share route writes `endedAt` on the meeting header.
2. A speech append to a meeting with `endedAt` files the speech under the
   day's next open meeting. Create that meeting if needed, using the same
   `YYYYMMDD-n` scheme. Respond `200 { ok, meetingId: <actual> }`.
3. Client (`drainOutbox`): when the response's `meetingId` differs from the
   entry's, adopt it. Advance `toastmaster_meeting_seq` to match and restamp
   the local report row (#2.1).
4. A share page stays a snapshot of what was shared. Freeze `/r/<token>` to
   the speech ids present at share time, or render only speeches with
   `finishedAt ≤ sharedAt`.

   Decide which one before implementing. The simpler is the `finishedAt`
   cutoff. Its catch: a speech still in flight during the share window lands
   with an earlier `finishedAt`, so it still appears. That is the right
   answer for it.

**Tests.**
- Worker: an append after share lands in `-2` and the response names it; the
  `/r/` count is unchanged.
- Client: the sequence and the row's meetingId follow the server.

---

## 6. Hiding the badge moves Reset under the cursor

**Evidence.** Visible badge controls are `[−][+][👁][↺]`. Hidden, they collapse
to `[👁‍🗨][↺]`, re-centred, so ↺ lands exactly where 👁 was. A hide → show tap
on the same spot resets the placement (`163900-c13-hidden-panel.png`, run.md
16:39).

**Fix.** In the badge control row (Zoom `TimerDisplay.jsx` ~l.137–214, and
the web equivalent), keep the slots fixed. When hidden, render `−` and `+` as
disabled or invisible placeholders, so 👁 and ↺ don't move. Optionally ask for
confirmation when Reset would discard a custom placement.

**Test.** DOM: the 👁 button's rect is the same when visible and when hidden.

---

## 7. `online` wake is ignored while the tab is hidden

**Evidence.** A web tab behind another window reported `visibilityState:
hidden`. `online` fired at 19:55:33 and nothing drained. The 15 s backoff
delivered at 19:55:43. With the tab visible, the same event drained in the
same millisecond.

**Cause.** `onWake()` (`clubArchive.js` ~l.420) returns early whenever
`document.visibilityState === 'hidden'`, even for the `online` event. A web
timer usually sits behind Zoom, so it is hidden most of the meeting.

**Fix.** Apply the hidden check only to `visibilitychange` (becoming visible
is the signal there). `online` drains regardless.

**Test.** jsdom with `visibilityState = 'hidden'`, dispatch `online`, expect
one upload.

---

## 8. Revoked rows can never leave the roster

**Evidence.** You revoked 10 duplicate rows and there was no way to remove
them. The console offers only Restore, and `club-cli prune-devices` skips
revoked rows by design ("a revoked row is the record of a decision"). The
roster reads "13 devices · 1 person" for three live devices.

**Fix.** Keep the record but hide it:
1. Add `POST /api/club/devices/<id>/archive` (admin only, revoked rows only).
   It sets `archivedAt` and leaves `revokedAt` in place, so a rejoin with that
   stable id still hits #4.1.
2. The roster omits archived rows from the list and from `counts`, with a
   "Show N removed devices" toggle. Add a console **Remove** button next to
   Restore on revoked rows.
3. `prune-devices --revoked` archives instead of deleting.

**Test.** Archive a revoked row → the roster count drops, and re-activating
that device id → 403.

---

## 9. Dev "Open in Zoom" and the no-JS shell still point at the prod app

**Evidence.** On dev, the landing page's visible **Open in Zoom** button links
`marketplace.zoom.us/zoomapp/DsFHK5sNQs2_VFyeQky2sg/…`. The served HTML shell's
static CTA (`apps/web/index.html:241`) links the prod OAuth URL.

**Cause.** These are hard-coded: `Landing.jsx:17` `ZOOM_APP_URL`,
`OAuthRedirect.jsx:56`, `BillingSuccess.jsx:78`, and `index.html:241`. 08 #7
moved only `VITE_ZOOM_OAUTH_REDIRECT`.

**Fix.**
1. Add `VITE_ZOOM_APP_ID` (default the prod id in `.env`, dev id in
   `cf:deploy:dev`). Build the deeplink as
   `` `https://marketplace.zoom.us/zoomapp/${id}/context/meeting/target/launch/deeplink` ``
   in one shared helper used by the three pages.
2. `index.html`: use Vite's `%VITE_ZOOM_OAUTH_REDIRECT%` HTML env
   replacement.

**Verify.**
`curl -s https://www.timer-dev.simple-tech.app/ | grep -o 'client_id=[^&"]*'`
and grep the Landing chunk for `zoomapp/kgpo`.

---

## 10. Small nits (batch into one PR)

- **Re-share title not pre-filled.** On a repeat share the title is kept, but
  the name field is empty, so it looks as though it will be dropped. Pre-fill
  it from `toastmaster_club_last_share.title` when `isRepeatShare`
  (`ReportTab.jsx`, both apps).
- **Zoom Pro modal after a second Leave** kept the club code, invite link and
  Manage your club visible until it was closed and reopened (run.md 16:02).
  `UpgradeModal.jsx:211` calls `leaveClub()` but the modal's club state isn't
  re-read. Update it from `loadClub()` / the club subscription after leave.
- **Zoom REPORT strip missing** once, right after leave + Set up my club in the
  same session (run.md 16:05). It returned after ⋯ → Refresh app. Likely the
  strip's club/outbox subscription is set up at mount and not re-bound when
  the club changes. Reproduce, then subscribe on `club.id` changes.
- **429 has no `Retry-After`.** Add `Retry-After: 60` to
  `json({ error: 'too_many_attempts' }, 429)` in `worker/club.js:252` and
  `worker/club-magic.js:294`.
- **Roster "first seen" resets on rejoin.** `/leave` deletes the row, so a
  rejoin mints a fresh `activatedAt`. Acceptable; note it in the console help,
  or keep a `firstSeenAt` in a small `club-device-seen:` key if the admin
  needs history.
- **Timing Role resets on reload / stage exit** (seen again; 08 finding).
  Persist the selected role per device.

---

## Config: Zoom "Accessing Untrusted Web Site" (still shown)

Zoom → Pro → **Manage your club** still stops at
`marketplace.zoom.us/z/…` "Accessing Untrusted Site" for
`www.timer-dev.simple-tech.app` (run.md 15:37). Same action as 08: Marketplace
→ dev app → *Features → Surface → Domain Allow List* → add the host (and
check that prod lists `www.timer.simple-tech.app` /
`www.timer.toastmusters.com`).

---

## Order and verification

1. **#1 + #4** together. They share the revoked state, and #1 is data loss.
2. **#2**. It needs `meetingId` on report rows, which #5 also uses.
3. **#5** (server + client). Decide the `/r/` snapshot rule first.
4. **#3** badge, with the DOM tests.
5. **#6, #7, #8, #9, #10** as small PRs, in any order.

After each deploy, re-run the matching lines of
`test-runs/2026-09-29-club-pro-retest/run.md` with the `zoom-app-testing` skill:

| Fix | What to re-run |
|---|---|
| #1 | revoked FINISH (16:00) |
| #2 | shares (16:11, 16:12) |
| #3 | badge (15:47, 16:04, 16:24, 16:36) |
| #4 | revoked rejoin (16:18) |
| #5 | cross-device append (16:28) |
| #6 | hide/show (16:39) |
| #7 | online while hidden (15:5x) |

Still unrun and needing the user:
- 5C.2, 5E, 5.4, 22, 23 need a second signed-in Zoom account; 5E also needs
  the gate at `"1"`.
- Step 8 part 2 needs real clicks.
