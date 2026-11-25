---
id: timer-sounds
title: Timer sounds (card-change chime, break music)
status: stale
covers:
  - packages/shared/timerSounds.js
  - apps/zoom-app/src/components/TimerSounds.jsx
  - apps/zoom-app/src/components/SoundsModal.jsx
  - apps/zoom-app/src/components/SoundsPanel.jsx
  - apps/zoom-app/src/hooks/useSounds.js
  - apps/zoom-app/src/hooks/useEntitlement.js
  - apps/zoom-app/src/components/LiveTab.jsx
  - apps/zoom-app/src/hooks/useLiveTimer.js
automated:
  - packages/shared/__tests__/timerSounds.test.js
  - apps/zoom-app/src/components/TimerSounds.test.jsx
  - e2e/zoom.timer-sounds.spec.js
  - e2e/web.timer-sounds.spec.js
needs:
  - dev deployed
  - FLAGS_FORCE "1" on dev (`pro` and `sounds` on); "0" for TS-09 only; "1,new_look=0,sounds=0"
    (per-key, plan 13 Phase 0) for TS-08 only
  - a free account, then a Pro one (club code via /pro/<CODE>, or a subscription)
  - speakers or headphones on the test computer
  - a second participant on another computer, for TS-07 only
  - since plan 13, FLAGS_FORCE "1" also turns on `new_look` (design B); these steps are written for
    today's panel, so wherever they say "1", deploy "1,new_look=0" ("0" already has it off)
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
free user who can switch sounds on, a Sounds button that hides instead of locking, a lock
that sells Pro before Pro can be bought, and a chime that stops when the timer switches tabs.

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

### TS-08 · auto · Locked for Pro while only the `sounds` flag is off
Do: on a Pro account, with `pro` on and `sounds` off (since plan 13 Phase 0, FLAGS_FORCE
"1,new_look=0,sounds=0" on dev; FLAGS_FORCE "0" turns `pro` off too, which is TS-09), open the
Live tab and click the speaker icon.
Expect: the icon is shown, grey with a lock. The modal opens with "Hold tight! Sounds are
coming soon." and no Upgrade link, and its controls cannot be used.
Evidence: screenshot.

### TS-09 · auto · Sounds say "coming soon" to everyone while the `pro` flag is off
Do: with FLAGS_FORCE "0" on dev, open the Live tab and click the speaker icon, on any
account: free, or the Pro account from TS-08 (a subscription, a grant, or a club on this
device).
Expect: the icon is grey with a lock, and hovering it shows "Hold tight! Sounds are coming
soon." The modal says the same, never "Sounds are a Pro feature.", has no Upgrade link, and
its controls cannot be used. The footer shows no Pro chip. Pro cannot be bought while the
`pro` flag is off, so nobody is told sounds are a Pro feature; the plan alone unlocks
nothing. Production stays in this state (with `sounds` on) until Pro launches.
Evidence: screenshot; `GET /api/me?flags=1` shows `"pro":false`.

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
- Production's exact pre-launch state, `sounds` on with `pro` off, for a free account.
  FLAGS_FORCE sets both flags together, so TS-09 runs with both off; the lock text is the
  same either way. `e2e/zoom.announcement-banner.spec.js` and the unit tests cover that pair.
- Break music from audio files. Only the synthesized "Music box" track ships so far; licensed
  tracks under `apps/zoom-app/public/music/` will add file playback, which needs its own
  step.
- The web timer's chime (`apps/web/src/components/TimerSounds.jsx`). It runs in a plain
  browser, which `e2e/` covers.
- Sound on Zoom mobile and web clients.
- START's `timer_started` analytics, including `audience_size` (#107). See
  [timer-core](timer-core.md) TC-10 to TC-12.
- A club card set re-pushing the card mid-speech (`LiveTab.jsx`). The chime follows the
  status (`cueForStatusChange` in `TimerSounds.jsx`), not the artwork, so it does not
  chime. See [club-card-sets](club-card-sets.md).
- The Live tab refusing an agenda row that needs a role (#91, `LiveTab.jsx`). Reviewed
  2026-11-13: it changes which speaker loads, not the sounds; no step here loads an agenda
  row. See [timer-core](timer-core.md) TC-13. Not rerun for it.
- RESET clearing the speaker's name in the shared timer state too (`useLiveTimer.js`,
  2026-11-21). Reviewed: it changes the name, not the status the chime follows; no step here
  depends on the name. See [timer-core](timer-core.md) TC-14. Not rerun for it.
- RESET also letting go of the agenda row and taking the role's current rules
  (`useLiveTimer.js`, 2026-11-25). Reviewed: TS-03's Reset is on Custom, whose rules it keeps,
  and the chime follows the status, not the speaker. See [timer-core](timer-core.md) TC-14.
  Not rerun for it.

Run 2026-11-16 (claude/redesign-b-p3 7e05b9a with #145 merged locally): TS-09 passed with FLAGS_FORCE "0" on the club Pro device
(the footer now shows the locked "Pro" coming-soon button, as on dev since 2026-11-14), and
TS-05 with "1,new_look=0" after several closes, reopens and a Refresh app. Not run: TS-01 (no
free account on the test Mac), TS-08 (needs FLAGS_FORCE cleared and `sounds` targeted off in
PostHog), and the human steps. Log: test-runs/2026-11-16-design-b-new-look-2/run.md.

Run 2026-11-19 (claude/redesign-b-p3 61de1d8 with dev c42fbbf merged locally (83fc093, not pushed); today's panel): TS-05 passed with FLAGS_FORCE "1,new_look=0" (Music
unticked, survived a close and reopen, re-ticked); TS-08 passed with "1,new_look=0,sounds=0"
(grey locked icon, "Hold tight! Sounds are coming soon.", no Upgrade link, amber Pro in the
footer); TS-09 passed with "0". TS-01 not run (needs a free account); TS-02/03/04/06/07 human
(audio). Still stale for TS-01 only. Log: test-runs/2026-11-19-design-b-stack-final/run.md.
