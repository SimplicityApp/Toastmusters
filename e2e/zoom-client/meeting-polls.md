---
id: meeting-polls
title: Meeting polls (Best Table Topics Speaker, Best Speaker, Best Evaluator)
status: stale
covers:
  - apps/zoom-app/src/App.jsx
  - apps/zoom-app/src/components/NavTabs.jsx
  - apps/zoom-app/src/components/ReportTab.jsx
  - apps/zoom-app/src/components/TimerStage.jsx
  - apps/zoom-app/src/utils/zoomSdk.js
  - packages/shared/club.js
  - packages/shared/clubArchive.js
  - packages/shared/reportImage.js
  - worker/club-meetings.js
  - worker/club-share.js
  - worker/zoom-webhook.js
automated:
  - worker/polls.test.js
  - worker/polls-zoom.test.js
  - worker/club-poll-template.test.js
  - packages/shared/__tests__/polls.test.js
  - apps/zoom-app/src/components/PollTab.test.jsx
  - apps/zoom-app/src/components/TimerStage.test.jsx
  - e2e/zoom.meeting-polls.spec.js
needs:
  - dev deployed (this branch, `npm run cf:deploy:dev`)
  - FLAGS_FORCE "1" on dev, so `polls` and `polls_zoom` are on
  - Zoom account A on Pro, host of the test meeting, an editor of a dev club (club-member record)
  - Zoom account B, a second participant on another computer, on the free plan
  - a guest device with `defaults write ZoomChat enableGuestModeTesting true`, Zoom restarted (MP-17)
  - a scheduled (not instant) test meeting for MP-13, MP-14 and MP-18
  - the Debug Panel's SDK Status (as CC-00) shows sendMessageToChat, getMeetingContext, sendAppInvitationToAllParticipants, authorize, onAuthorized and promptAuthorize granted
  - ENTITLEMENT_ENFORCE "1" on dev for MP-01 only (ask first; revert after)
verified_at: never
verified_on: never
---

# Meeting polls (Best Table Topics Speaker, Best Speaker, Best Evaluator)

Issue #80. A Pro organizer builds a ballot from this meeting's timed speakers, opens it,
invites everyone into the app to vote with their verified Zoom identity (the web link
`/vote/<id>` is the backup), closes it and reveals the winners on the sidebar, the Stage,
the Report tab, the report image and the shared `/r/` page. A host can also create it as a
native Zoom poll, whose results the Worker fetches after the meeting. Unit and Playwright
tests prove the logic, the Worker's checks and the UI in a plain browser. Only the real
client proves the SDK bridge (chat, invite, meeting context, authorize), the real Zoom
identities of a second participant and a guest, Zoom's own poll window and the
meeting.ended webhook.

When the implementation lands, add its files to `covers` (`PollTab.jsx`, `PollVote.jsx`,
`worker/polls.js`, `packages/shared/polls.js`); they are left out here only because
`npm run test:specs` refuses a path that does not exist yet.

## Purpose
Catches a poll that cannot be opened from inside Zoom, a voting link that points at the
`zoom.` host (which routes every path to the sidebar app), a chat post or invite that
fails silently, a vote counted twice for one Zoom account, a guest who cannot vote, a free
plan that can run a poll or cannot vote, winners that never reach the Stage, the Report
tab or the club archive, and a native poll whose results never come back after the meeting.

## Steps

### MP-01 · auto · A free plan sees the setup locked, and can still vote
Do: with ENTITLEMENT_ENFORCE "1", sign in as a free account, open the app, click the POLL tab.
Expect: the POLL tab sits after REPORT; the setup is replaced by "Upgrade to Pro", which opens the upgrade modal. No "Open poll" button.
Evidence: `upgrade_prompt_shown` with `source: "polls"` in PostHog; a direct `POST /api/polls` with this session answers 402 `upgrade_required`.

### MP-02 · auto · The ballot is built from this meeting's timed speakers
Do: as A, time two Table Topics speakers (Bob, Carol, then Bob again) and one Standard Speech (Alice), then open the POLL tab.
Expect: three categories, Table Topics Speech, Standard Speech, Table Topics Evaluation; Table Topics lists Bob, Carol (once each, in timing order); Standard Speech lists Alice; Table Topics Evaluation shows three empty slots.
Evidence: `toastmaster_reports` in localStorage holds the four speeches; screenshot of the POLL tab.

### MP-03 · auto · Categories, candidates and a new role
Do: add a category, set its role to a custom role, rename a candidate, add one, remove one, remove the category; then choose "New role…" in a category's role select, name it "Humorous Speech Contest" and add it.
Expect: each edit shows at once; the new role becomes that category's role and appears in the LIVE tab's role list with the default custom rules.
Evidence: `toastmaster_role_rules` gains "Humorous Speech Contest"; `role_added` in PostHog.

### MP-04 · human · The voting link is posted to the meeting chat
Do: with "Post to chat" on, click "Open poll". The user confirms the chat message (it sends a message to the meeting).
Expect: the sidebar shows `https://www.timer-dev.simple-tech.app/vote/<id>` with Copy link; the meeting chat shows the same link once. With "Post to chat" off, nothing is posted and Copy link still shows.
Evidence: `POST /api/polls` 201 in the Worker log; `poll_opened` in PostHog; screenshot of the chat.

### MP-05 · human · A second device votes through the link
Do: on a phone or another browser with no Zoom sign-in, open the link, pick a candidate, submit; then reload and try to vote again in the same category.
Expect: the ballot shows the names and labels, no counts, and the "one vote per device" note; the first vote says thanks; the second is refused ("already voted").
Evidence: Worker log `POST /api/polls/<id>/votes` 200 then 409; `poll_vote_cast` with `path: "link"`.

### MP-06 · auto · Only the owner sees counts, and they update
Do: keep the POLL tab open on A while MP-05 votes arrive; then request `GET /api/polls/<id>/results` with B's session and with none.
Expect: A's counts update within about 5 s, with an "in Zoom / guest / link" split; B gets 403, no session gets 401.
Evidence: Worker log of the 5-second results reads; the two refused requests.

### MP-07 · auto · Close and reveal
Do: as A, click "Close poll".
Expect: each category shows only its winners; a tie shows every tied name; a category with no votes says "No votes". Votes after closing are refused.
Evidence: `POST /api/polls/<id>/close` 200; `poll_closed` in PostHog; `toastmaster_poll_results` in localStorage holds the winners.

### MP-08 · auto · The winners on the shared Stage
Do: as A, click "Show on Stage", switch to Stage mode and share it to the meeting.
Expect: the shared Stage shows the winners panel over the artwork, as seen from B's screen; nobody else's Stage changes.
Evidence: screenshot from B's machine, or from A's share preview.

### MP-09 · auto · Results on the Report tab and in the club archive
Do: on A (a club device), open the REPORT tab after MP-07; then read the meeting from the club archive.
Expect: the Report tab shows a results card with each category's winners; `GET /api/club/meetings/<meetingId>` returns them under `polls`, before and after the meeting is compacted.
Evidence: Worker log `POST /api/club/meetings/<meetingId>/polls` 200; KV key `poll:<clubId>:<meetingId>:<pollId>`.

### MP-10 · auto · An editor publishes the ballot setup to the club
Do: as A (editor), click "Publish to club"; on a member device of the same club, reopen the app so the club refreshes.
Expect: the member's POLL tab starts from the published categories.
Evidence: `PUT /api/club/poll-template` 200 and the club's `ver` bumped; `toastmaster_club_poll_template` on the member device.

### MP-11 · auto · A member edits for one meeting only
Do: on the member device, rename a candidate and open a poll.
Expect: the club template and the member's stored copy are unchanged; the member sees no "Publish to club" button.
Evidence: `toastmaster_club_poll_template` byte-identical before and after; no `PUT /api/club/poll-template` from the member.

### MP-12 · auto · A personal template syncs
Do: as a Pro account with no club, click "Save as my template"; open the app on a second device signed in to the same account.
Expect: the second device's POLL tab starts from the saved categories.
Evidence: `toastmaster_poll_template` in the `/api/profile` PUT body and on the second device.

### MP-13 · human · "Create as Zoom poll" is the host's, and refuses an instant meeting
Do: as A (host) in an instant meeting, open a poll and click "Create as Zoom poll"; approve Zoom's authorization prompt if shown. Then open the app as B.
Expect: the button and Zoom's limits (host only, Zoom Pro with polling on, scheduled meetings only) show for A only; on the instant meeting the app says it cannot create a poll there.
Evidence: `POST /api/polls/zoom` 4xx with the instant-meeting reason; no `POST /meetings/{id}/polls` in the Worker log.

### MP-14 · human · On a scheduled meeting the native poll is created
Do: repeat MP-13 in the scheduled test meeting; open Zoom's Polls window.
Expect: one single-choice question per category, the candidates as answers; A can launch it from Zoom's window.
Evidence: `zoom_poll_created` in PostHog; Worker log `POST /meetings/{id}/polls` 201; the refresh token appears in no log line.

### MP-15 · human · The open poll is found in the meeting, and "Invite everyone" reaches B
Do: as A, click "Invite everyone". The user confirms on B's machine that the invitation arrives and opens the app.
Expect: B's app shows "Vote now" and opens the POLL tab on the ballot; A's own app shows no "Vote now".
Evidence: `poll_invite_sent` in PostHog; B's `POST /api/polls/current` 200.

### MP-16 · human · A second participant votes inside Zoom, once per account
Do: on B, vote in one category; then try the same category again from B's account on another device.
Expect: the first vote says "Thanks, your vote is in" with no counts; the second is refused. A's split counts it under "in Zoom".
Evidence: Worker log votes 200 then 409; `poll_vote_cast` with `path: "zoom"`.

### MP-17 · human · A guest votes
Do: on the guest device (Guest Mode Testing on), join the meeting as a guest and open the app.
Expect: the guest finds the poll and votes; A's split counts it under "guest".
Evidence: `poll_vote_cast` with `path: "guest"`.

### MP-18 · human · The native poll's results arrive after the meeting
Do: after MP-14, launch and answer the Zoom poll, end the scheduled meeting, wait 6 minutes, open the REPORT tab on A.
Expect: the Report tab shows the Zoom poll's answer counts per question.
Evidence: `zoom_poll_results_fetched` in PostHog; Worker log `GET /past_meetings/{uuid}/polls` 200 about 5 minutes after `meeting.ended`.

### MP-19 · auto · The report image and the shared page show the winners
Do: on A (club device), after MP-07, use "End meeting & share", then open the `/r/` link and the downloaded image.
Expect: both list each category with its winners (ties joined, "No votes" for an empty one); a meeting without a poll looks as before.
Evidence: the `/r/<token>` HTML; the PNG from `/api/club-assets/<clubId>/r-<token>-full.png`.

## Not covered
- Deliberate double voting through the web link from several browsers: one vote per device is documented as not proof against it, and the per-poll-and-address limit (120 a minute) is proven by unit tests only.
- The 24-hour deletion of the stored refresh token when no meeting.ended arrives, and the +15/+60 minute retries: unit tests (`worker/polls-zoom.test.js`) only.
