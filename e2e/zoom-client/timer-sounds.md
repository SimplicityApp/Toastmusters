---
id: timer-sounds
title: Timer sounds (card-change chime, break music)
status: draft
covers:
  - packages/shared/timerSounds.js
  - apps/zoom-app/src/components/TimerSounds.jsx
  - apps/zoom-app/src/components/SoundsModal.jsx
  - apps/zoom-app/src/hooks/useSounds.js
  - apps/zoom-app/src/components/LiveTab.jsx
automated:
  - packages/shared/__tests__/timerSounds.test.js
  - apps/zoom-app/src/components/TimerSounds.test.jsx
  - e2e/zoom.timer-sounds.spec.js
  - e2e/web.timer-sounds.spec.js
needs:
  - dev deployed
  - FLAGS_FORCE "1" on dev (the `sounds` flag on); "0" for TS-08 only
  - a free account, then a Pro one (club code via /pro/<CODE>, or a subscription)
  - speakers or headphones on the test computer
  - a second participant on another computer, for TS-07 only
verified_at: never
verified_on: never
---

# Timer sounds (card-change chime, break music)

The Pro sound feature from #105. Sound comes out of the Zoom webview on the timer's own
computer; no Zoom Apps API plays it into the meeting. Unit tests prove when the engine is
asked to play. Only a real client proves that the webview is allowed to make sound at all,
and only a second participant proves that "Share sound" carries it.

## Purpose
Catches a webview that blocks Web Audio (autoplay policy), so the chime is silent in Zoom
while it works in a browser. Also catches music that keeps playing after a break ends, a
free user who can switch sounds on, a Sounds button that hides instead of locking, and a chime that stops when the timer switches tabs.

## Steps

### TS-01 · auto · Sounds button and the locked modal on a free plan
Do: open the app on a free account. On the Live tab, with the timer stopped, click the
speaker icon to the right of the Card Images icon under the preview colours.
Expect: the speaker icon is grey with a small lock, and hovering it shows "Sounds are a Pro
feature. Upgrade to Pro to use them." It opens a "Sounds" modal with a Pro tag and a lock,
the text "Sounds are a Pro feature.", and greyed-out controls with a lock beside each
title. The checkboxes cannot be ticked, and hovering them shows the same tooltip.
Evidence: screenshot; `localStorage.toastmaster_sound_settings` is absent or has
`"cues":false`.

### TS-08 · auto · Locked for Pro while the `sounds` flag is off
Do: on a Pro account, with `sounds` off (FLAGS_FORCE "0" on dev, or the flag off in
PostHog), open the Live tab and click the speaker icon.
Expect: the icon is shown, grey with a lock. The modal opens with "Sounds are coming
soon." and no Upgrade link, and its controls cannot be used.
Evidence: screenshot.

### TS-02 · human · Test chimes are audible in the Zoom webview
Do: on a Pro account, open Sounds and click Test: Green, Yellow, Red.
Expect: one, two, then three soft rising notes. Not loud, no clicks or distortion.
Evidence: the user confirms by ear (audio cannot be read from a screenshot).

### TS-03 · human · Chime at each card during a real speech
Do: tick "Chime when the card changes" and close the modal. Pick Custom with green 0:05,
yellow 0:10, red 0:15. Start. At 0:07, switch to the Agenda tab.
Expect: one note at 0:05, two at 0:10 (heard while on Agenda), three at 0:15. Reset makes
no sound.
Evidence: the user confirms by ear; PostHog `sound_settings_changed` with
`setting: "cues"`, `value: true`.

### TS-04 · human · Break music plays, pauses and stops at 00:00
Do: tick "Music during breaks". Pick Take a Break, set Custom to 0:30, Start. After 10 s,
Stop, then Start again.
Expect: a cheerful music-box loop while it counts down. It stops on Stop and resumes on
Start. It stops at 00:00 (red).
Evidence: the user confirms by ear.

### TS-05 · auto · Settings survive closing the app
Do: close the app and reopen it from the Apps menu. Open Sounds.
Expect: the chime and music checkboxes are as left in TS-03/TS-04, and so is the volume.
Evidence: `localStorage.toastmaster_sound_settings`, e.g.
`{"cues":true,"music":true,"track":"music-box","volume":0.7}`.

### TS-06 · human · Volume slider
Do: drag Volume to the far left and release, then to the middle and release.
Expect: silence at the far left. A single green note on release in the middle.
Evidence: the user confirms by ear.

### TS-07 · human · The speaker hears the chime through Share sound
Do: a second participant joins from another computer. Share the screen with "Share sound"
on, then run the Custom speech from TS-03. Repeat while sharing the stage with the app's own
share (Timer Stage).
Expect: the second participant hears the chimes with screen share plus Share sound. Record
whether the app's own share carries sound. The modal's tip only promises the former.
Evidence: the second participant confirms; note the result for each share path in the run
log.

## Not covered
- Break music from audio files. Only the synthesized "Music box" track ships so far; licensed
  tracks under `apps/zoom-app/public/music/` will add file playback, which needs its own
  step.
- The web timer's chime (`apps/web/src/components/TimerSounds.jsx`). It runs in a plain
  browser, which `e2e/` covers.
- Sound on Zoom mobile and web clients.
