---
id: new-look
title: Design B, the redesigned panel (new_look)
status: stale
covers:
  - apps/zoom-app/src/b
  - apps/zoom-app/src/App.jsx
  - apps/zoom-app/src/hooks/useNewLook.js
  - apps/zoom-app/src/components/VideoPreviewLayer.jsx
  - apps/zoom-app/src/hooks/useRulesEditor.js
  - apps/zoom-app/src/components/TimerStage.jsx
  - apps/zoom-app/src/components/ProLaunchModal.jsx
  - apps/zoom-app/src/components/ClubSurveyModal.jsx
  - apps/zoom-app/src/components/UpgradeModal.jsx
automated:
  - e2e/zoom.new-look.spec.js
  - apps/zoom-app/src/hooks/useLiveTimer.test.jsx
  - apps/zoom-app/src/b/NewLookShell.test.jsx
  - apps/zoom-app/src/b/TimerCard.test.jsx
  - apps/zoom-app/src/b/TopBar.test.jsx
  - apps/zoom-app/src/b/Sheet.test.jsx
  - apps/zoom-app/src/b/AgendaReport.test.jsx
  - apps/zoom-app/src/b/Phase3.test.jsx
  - apps/zoom-app/src/hooks/useNewLook.test.js
needs:
  - dev deployed
  - camera on, in a meeting
  - FLAGS_FORCE "1,pro=0" on dev (`new_look` on, `pro` off, the mix production will launch with); "1" for NL-09's second half and NL-10
  - the test device in a club with Pro for NL-10 (it is: Claude Test Club)
verified_at: never
verified_on: never
---

# Design B, the redesigned panel (new_look)

## Purpose
Plan 13 redraws the whole Zoom panel behind the `new_look` flag: one timer card whose
colour is the meeting's, a 16:9 preview with the count-up chip and club badge to drag, a
"Look & sound" section of sheets, the ⋯ menu, no footer. The plain-browser e2e proves the
layout; this proves what only the real client shows: that the card's buttons still drive
the colour on the organizer's real video, that a drag on the 16:9 preview lands where the
preview says, that each sheet's setting reaches the video, and that the panel fits Zoom's
own width.

## Steps

### NL-01 · auto · The new look appears, fits, and has no footer
Do: deploy dev with FLAGS_FORCE "1,pro=0", open Toastmasters Timer from Apps.
Expect: one top row: Agenda / Timer / Report, a grey "Pro" chip with a lock, and ⋯. No
footer. The Timer tab shows the blue card with "Who's speaking?", the role, the rules line,
the preview, 00:00, "Ready · green at …", the four swatches, Start and Reset, then the four
"Look & sound" rows. No horizontal scrollbar; Start is visible without scrolling. The one-time
hint beside the chip ("Drag me to move. Point at me to resize or hide.") wraps inside the panel.
Evidence: screenshot; `localStorage.toastmaster_new_look_last` is "1".

### NL-02 · auto · The card drives the colour on real video
Do: open "Who's speaking?", type `NL Test`, Enter. Pick Short Roles in the role list. Start,
and let it run past 1:00. Finish.
Expect: the card and the video turn green at 0:30, yellow at 0:45, red at 1:00; the status
line follows ("Green · yellow at 0:45", …, "Red phase"). After Finish the card is blue and
empty again, and the Report tab lists NL Test.
Evidence: screenshots at each colour; `toastmaster_reports` holds NL Test.

### NL-03 · auto · A chip drag lands on the video where the preview shows it
Do: with a swatch held (Preview green), drag the count-up chip to the bottom right of the
preview and release.
Expect: the count-up on the video moves to the bottom right. The push happens once, on
release.
Evidence: one `setVirtualBackground` / filter push in the debug log for the drag;
`toastmaster_overlay_time_readout` holds x > 0.7, y > 0.7.

### NL-04 · auto · The chip's controls show on hover only
Do: move the pointer away from the preview, then onto the chip. Press +, then the eye. Show it
again, drag the chip to the bottom right of the preview (over the status line), and press + there.
Then drag it past the preview's right edge and release outside the preview.
Expect: − / + / eye are hidden until the pointer is on the chip. + makes the count-up on the
video larger; the eye hides it from the video (the chip dims). At the bottom right the buttons
still take clicks (the status line under the clock does not cover them, and its text does not
show through them) and all three stay inside the panel, to the chip's left. Released outside,
the drag ends and the chip stays inside the preview, where the video draws the count-up.
Evidence: screenshots before and after hover; readout scale and visibility in
`toastmaster_overlay_time_readout`.

### NL-05 · auto · On your video: each mode from its sheet
Do: open "On your video". Pick Timer only; then reopen and pick Camera + timer; then
Full-screen timer, and close the stage with its ×.
Expect: Timer only shows the toast "Timer only: the colour replaces your camera until you
clear it." and the colour replaces the camera; Camera + timer puts the camera back over the
colour; Full-screen timer covers the panel with the stage. The row's note follows the mode.
Evidence: screenshots; `toastmaster_overlay_mode`.

### NL-06 · auto · Clear the timer from the video, from the sheet and from ⋯
Do: hold a swatch so the colour is on the video. "On your video" → Clear from my video.
Hold the swatch again, switch to the Report tab, ⋯ → Clear the timer from my video.
Expect: both times the colour leaves the video; the second also switches back to the Timer
tab. Zoom may ask to confirm in Camera + timer.
Evidence: screenshots; "Cleared the timer from your video." toast.

### NL-07 · auto · Cards: the card set reaches the video, and the sheet holds only cards
Do: open "Cards", pick Modern, close. Hold the green swatch.
Expect: the sheet lists the card sets and "Add your own", and no background picker. The
video shows the Modern green card; the row's note reads Modern.
Evidence: screenshot; `toastmaster_custom_card_images` names the active set.

### NL-08 · auto · Between speeches: timer card or my video
Do: open "Between speeches". With "Timer card" chosen, run and Finish a short speech; then
choose "My video" and run and Finish another.
Expect: with Timer card the blue card stays on the video after Finish; with My video the
timer comes off the video after Finish (Zoom may ask to allow it). The row's note reads
Timer card, then My video.
Evidence: screenshots after each Finish; `toastmaster_reveal_face_when_idle`.

### NL-09 · auto · Sounds: locked before the launch, open with Pro
Do: open "Sounds" with FLAGS_FORCE "1,pro=0". Then redeploy with "1" on the club Pro device
and open it again.
Expect: first the row shows PRO and the sheet says "Hold tight! Sounds are coming soon." with
the controls disabled; then the controls work and the row's note reads "Off" (or what is on).
Evidence: screenshots.

### NL-10 · auto · Club badge: hover controls and drag reach the video
Do: with FLAGS_FORCE "1" on the club device, point at the club badge on the preview, press +,
then drag it to the far bottom left, release near the panel's left edge (off the badge), and
move the pointer away; press reset.
Expect: − / + / eye / reset appear on hover only; the badge on the video grows, moves on
release, and returns to the club's position on reset. The drag ends even though that release
never reaches the app: moving away does not drag the badge again, and its buttons come back on
hover. On the preview the badge shows the club's whole name and stays inside the preview, at the
top right and at the far bottom left, where the video puts it.
Evidence: screenshots; `toastmaster_club_badge`.

### NL-11 · auto · The ⋯ menu's help items
Do: ⋯ → How-to videos; ⋯ → Send feedback (close it); ⋯ → Rate the app.
Expect: the browser opens www.toastmusters.com/tutorials; the feedback dialog opens in the
panel; the browser opens the Marketplace listing. On the dev app Zoom stops How-to videos at
"Accessing Untrusted Site": its Domain Allow List lacks www.toastmusters.com (the production
app allows it). That stop is the pass on dev.
Evidence: screenshots of the browser tabs.

### NL-12 · human · Video off
Do: turn the camera off in Zoom.
Expect: an amber "Your video is off" notice above the card with "Turn video on", Start
disabled, and the status line "Start works once your video is on". Turn video on brings the
camera back and enables Start.
Evidence: screenshots. Human: the camera toggle is the user's.

### NL-13 · auto · Agenda: paste, pick the missing role, time from the agenda
Do: Agenda tab → Paste from EasySpeak; paste `demo-agenda-easyspeak.txt`; Add. Then Paste → One
per line: `NL One (Short Roles)` and `NL Two (Table Topics Master)`; Add. Pick Table Topics
Speech on NL Two's red row. Tap NL One.
Expect: the counts match ("Found N speakers"); NL Two is red with "(Table Topics Master) is not
one of your roles" until a role is picked; tapping NL One opens the Timer tab with NL One on the
card and "Up next: NL Two"; a Start there turns the video green at 0:30.
Evidence: screenshots; `toastmaster_agenda`.

### NL-14 · auto · Report: rows, copy, clear
Do: finish two short speeches, one past red plus grace. Report tab → Copy report; Clear (cancel,
then confirm).
Expect: one row per speech with its colour dot, time and last colour, "OVER TIME" on the long
one and the grace note under the list; the clipboard holds the tab-separated report, or where
Zoom refuses the app the clipboard (desktop 7.2.5 does) a "Copy the report" sheet shows that text
to select; Clear asks first and then empties the list.
Evidence: screenshots; clipboard text; `toastmaster_reports`.

### NL-15 · auto · Report for a club with Pro: archive, history, share
Do: with FLAGS_FORCE "1" on the club device, finish a speech; Report tab → History, open the
newest meeting, back; End meeting & share with a name.
Expect: "Saved to Claude Test Club" above the list (or "waiting to upload" while offline);
History opens as a sheet listing meetings; the meeting opens with the club header; the share
sheet ends with "Meeting saved", the text with its link, and WhatsApp / Email / Copy image / Copy
link; the note says Clear only empties this device.
Evidence: screenshots; `POST /api/club/meetings/...` in the Worker log.

### NL-16 · auto · Roles & timing rules: edit, save, and the club's list
Do: ⋯ → Roles & timing rules; open Short Roles; set Green to 0:20; Save. Start a Short Roles
speech. On the club device (FLAGS_FORCE "1"), open the sheet again.
Expect: rows show each role's three times; one row opens at a time; no role row shows below the
Reset all / Save footer; after Save the role list shows 0:20 · 0:45 · 1:00 and the video turns
green at 0:20. On the club device the strip reads "Using Claude Test Club's timings" with
"Use mine", or, once this device saved its own rules, "Using your own timings" with "Use Claude
Test Club's"; each button switches to the other and back without losing the device's rules.
Evidence: screenshots; `toastmaster_role_rules`.

### NL-17 · auto · Pro chip and ⋯ once Pro is released
Do: with FLAGS_FORCE "1" on a free device, look at the top row; press the Pro chip; close; ⋯.
Expect: a blue "Pro" chip with the red launch dot; Upgrade opens as a sheet from the bottom edge
with the PRO tag, the prices and the club code field; ⋯ starts with "Your plan · Free · See Pro"
and "Join my club with a code". On the club Pro device the chip is amber; it opens the Pro sheet
("You're on Pro through Claude Test Club", Manage billing; no "Leave" for the club's owner), and ⋯ starts with "Your plan ·
Pro · Manage" with no "Join my club" row.
Evidence: screenshots.

### NL-18 · auto · The full-screen timer from its sheet
Do: "On your video" → Full-screen timer; press "Share to the meeting"; stop sharing; close the
stage.
Expect: the stage covers the panel with the card artwork; the share button reads "Share to the
meeting" and starts a Zoom share of the timer; closing returns to the panel in Timer only.
Evidence: screenshots; Zoom's share toolbar.

### NL-19 · auto · The club question as a sheet
Do: on a device that has not answered the club question, deploy dev built with
`VITE_ENABLE_DEBUG_PANEL=true` (it drops the prompts' time gates; design B has no debug panel of
its own), then FINISH speeches until the club question is due.
Expect: "Which club are you from?" rises as a sheet; Not now closes it; Don't ask me again
retires it.
Evidence: screenshots; `toastmaster_prompts`.

### NL-20 · auto · The top note on the new look
Do: on a device that never closed it, open the app with FLAGS_FORCE "1,pro=0".
Expect: "New look: the timer sits in the middle now, with your settings under Look & sound. Pro
is coming soon." above the top row (see announcement-banner AB-05).
Evidence: screenshot.

### NL-21 · auto · Finish and Reset clear the speaker; the idle card follows a rules edit
Seen in the 2026-11-19 run: after Finish a tab switch put the speaker who had just finished back
on the card, and Start timed them again under their name. The idle card also kept a role's old
times after a rules edit, until Start.
Do: Timer tab, a short role. "Who's speaking?" → type `NL Spec`, Enter (it adds them as the
agenda's last row). Start, about 5 s, Finish. Agenda tab, wait until it shows, then Timer. Start,
about 3 s, Finish. Then "Who's speaking?" → `NL Reset`, Enter; Start, about 3 s, Stop, Reset;
Report tab, wait until it shows, then Timer. Last, ⋯ → Roles & timing rules, open the role in
use, set Green 10 s earlier, Save, and read the card before any Start; then set Green back.
Expect:
- After the first Finish the card reads "Who's speaking?" on the same role, and still does after
  the Agenda/Timer switch.
- The Report has one `NL Spec` row, then a row with no name. No second `NL Spec`.
- After Reset, and after the Report/Timer switch, the card reads "Who's speaking?".
- After Reset the Agenda tab shows `NL Reset` neither current nor done.
- After Save the card's rules line shows the new green time at once, not the old one.
Evidence: screenshots of the card after each switch, of the Report, and of the rules line
before and after Save.
Then: delete `NL Spec` and `NL Reset` from the agenda; leave the Report rows unless it was
empty before.
Run 2026-11-25 (fix/finish-clears-speaker 0088e3a, dev 2a7f6ad7 with FLAGS_FORCE "1,pro=0", role
ChairToast1): NL-21 passed. Finish and Reset left "Who's speaking?" across the Agenda/Timer and
Report/Timer switches; Report: `NL Spec` 00:10, then Unnamed. After Reset, `NL Reset` showed as
"Up next", neither current nor done. A Green 30→20 Save moved the idle rules line to 0:20 at once.
Log: test-runs/2026-11-25-finish-clears-speaker-2/run.md.

Run 2026-11-16 (claude/redesign-b-p3 7e05b9a with #145 merged locally; FLAGS_FORCE "1,pro=0", then
"1" for NL-09's second half, NL-10, NL-15, NL-16's club half and NL-17): NL-01–NL-03, NL-05–NL-11,
NL-13–NL-18 and NL-20 passed. ❌ NL-04 at the bottom right: the status line under the clock
(`opacity-95`, its own stacking context) covered − / +, and the eye hung outside the panel near
the right edge; NL-01's hint ran off the panel; NL-16's footer left a strip where rows showed.
All three fixed after the run (chip and badge at `z-10`, no opacity on the status line, buttons on
the chip's left near the right edge, hint `max-w-[11rem]`, footer covering the sheet's padding)
with unit and e2e checks. Rerun 2026-11-16 on d7b2579 with FLAGS_FORCE "1" (the hint's seen-key
renamed in that build only, so the hint showed again): NL-01, NL-04 (bottom right: − / + / eye on
the chip's left, all take clicks), NL-10 and NL-16 (nothing under the footer) pass. Not run: NL-12
(human), NL-19 (no prompt due), NL-17's free half (no free device). Logs:
test-runs/2026-11-16-design-b-new-look-2/run.md, test-runs/2026-11-16-design-b-rerun/run.md.
Run 2026-11-17 on the cosmetic fixes (FLAGS_FORCE "1"): NL-04's buttons over the status line and
NL-10's badge at both edges pass; it also found a badge drag released near the panel's left edge
never ending (the release never reached the app) and the chip hanging off the panel at the right
edge. Both fixed and rechecked in the same run (626f49fc). Log:
test-runs/2026-11-16-design-b-cosmetic-fix/run.md.
Run 2026-11-19 on the final head (claude/redesign-b-p3 61de1d8 with dev c42fbbf merged locally (83fc093, not pushed); FLAGS_FORCE "1,pro=0", then "1" for NL-09's
second half and NL-17): NL-01–NL-09, NL-11, NL-13, NL-14 (Clear cancelled, not confirmed: it
would empty the device's 33-speech report), NL-16's device half, NL-18 and NL-20 passed, with
1min Role (0:30 · 0:45 · 1:00) standing in for Short Roles and ChairToast3 for Table Topics
Speech. NL-14's copy went to the "Copy the report" sheet (Zoom refused the clipboard). Not run:
NL-10, NL-15, NL-16's club half and NL-17's club half (the device had dropped out of its club;
it is now personal Pro), NL-17's free half (no free device), NL-19 (needs a debug build),
NL-12 (human). Findings, none blocking: after Finish a tab switch puts the finished speaker
back on the card (useLiveTimer's useState(currentSpeaker?.name); the context never clears
currentSpeaker), and the idle card shows that snapshot's old times after a rules edit; on a
personal-Pro device with no club, ⋯ → "Join my club with a code" opens a Pro sheet with no code
field. Log: test-runs/2026-11-19-design-b-stack-final/run.md.

Run 2026-11-24 (factory/167 9d094d6, the steps #167 touches; dev e2c40064 with FLAGS_FORCE "1,pro=0", then
c5175c33 with "1"): NL-01, NL-09, NL-10, NL-15, NL-16's club half and NL-17's club Pro half passed (no Leave for
the owner; ⋯ has no "Join my club" row on a Pro device). NL-20 ⏭ (this device closed the note before), NL-17's
free half ⏭ (no free account). The other steps were not rerun: #167 does not touch them; they last passed on
61de1d8 (2026-11-19). Log: test-runs/2026-11-24-167-zoom-pass-2/run.md.

## Not covered
- Reviewed against the #167 implementation: the Pro sheet's code field now reads "Already on Pro
  with your club?" (its accessible name still starts "Already on Pro through your club?"), the
  joined sheet reads "You're on Pro through <club>" with Leave behind an in-sheet confirm, and
  guests are asked to sign in or approve before a code is sent ([club-membership](club-membership.md)).
  NL-17 already says so; no step moves.
- Today's panel with `new_look` off: the other specs, run with FLAGS_FORCE "1,new_look=0".
- Audio of the sounds: timer-sounds.
- The connection and club-renewal banners: unchanged by design B (they already sit at the top
  as the boards draw them); connection-notice and club-renewal-reminder cover them.
- Dragging agenda rows: the same dnd-kit sorting as today's tab, covered by the e2e and unit tests.
- The club badge on the full-screen stage: sized against the 16:9 card band and kept clear of
  the controls by `stageBadgeLayout` (#165), the same code under both looks. See
  [stage-club-badge](stage-club-badge.md). Reviewed against the dev merge that brought #165 in
  (9cb4e5f): design B's `TimerStage.jsx` change is only the share button's wording, so no step
  here moves.
