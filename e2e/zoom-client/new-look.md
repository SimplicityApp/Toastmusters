---
id: new-look
title: Design B, the redesigned panel (new_look)
status: draft
covers:
  - apps/zoom-app/src/b
  - apps/zoom-app/src/App.jsx
  - apps/zoom-app/src/hooks/useNewLook.js
  - apps/zoom-app/src/components/VideoPreviewLayer.jsx
automated:
  - e2e/zoom.new-look.spec.js
  - apps/zoom-app/src/b/NewLookShell.test.jsx
  - apps/zoom-app/src/b/TimerCard.test.jsx
  - apps/zoom-app/src/b/TopBar.test.jsx
  - apps/zoom-app/src/b/Sheet.test.jsx
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
"Look & sound" rows. No horizontal scrollbar; Start is visible without scrolling.
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
Do: move the pointer away from the preview, then onto the chip. Press +, then the eye.
Expect: − / + / eye are hidden until the pointer is on the chip. + makes the count-up on the
video larger; the eye hides it from the video (the chip dims).
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
then drag it to the bottom left and release; press reset.
Expect: − / + / eye / reset appear on hover only; the badge on the video grows, moves on
release, and returns to the club's position on reset.
Evidence: screenshots; `toastmaster_club_badge`.

### NL-11 · auto · The ⋯ menu's help items
Do: ⋯ → How-to videos; ⋯ → Send feedback (close it); ⋯ → Rate the app.
Expect: the browser opens www.toastmusters.com/tutorials; the feedback dialog opens in the
panel; the browser opens the Marketplace listing.
Evidence: screenshots of the browser tabs.

### NL-12 · human · Video off
Do: turn the camera off in Zoom.
Expect: an amber "Your video is off" notice above the card with "Turn video on", Start
disabled, and the status line "Start works once your video is on". Turn video on brings the
camera back and enables Start.
Evidence: screenshots. Human: the camera toggle is the user's.

## Not covered
- Today's panel with `new_look` off: the other specs, run with FLAGS_FORCE "1,new_look=0".
- Audio of the sounds: timer-sounds.
- Agenda and Report tabs in the new look, the Roles & timing rules sheet, the Pro sheets,
  the banners and the stage restyle: steps added with plan 13's Phases 2 and 3.
