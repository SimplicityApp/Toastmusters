---
id: timer-core
title: Core timer in the Zoom client
status: stale
covers:
  - apps/zoom-app/src/context/TimerContext.jsx
  - apps/zoom-app/src/components/LiveTab.jsx
  - apps/zoom-app/src/utils/zoomSdk.js
  - packages/shared/clubBadge.js
automated:
  - e2e/zoom.timer-flow.spec.js
  - apps/zoom-app/src/utils/zoomSdk.test.js
  - apps/zoom-app/src/components/LiveTab.test.jsx
needs:
  - dev deployed
  - camera on, in a meeting
verified_at: 2e965b6
verified_on: 2026-11-11 (Zoom 7.2.5, macOS 26.7.2, dev a4c66603)
---

# Core timer in the Zoom client

Migrated from `docs/ZOOM_TEST_PLAN.md` Steps 2, 3 and 3b. The free timer must work in a real
meeting: background colours follow the thresholds, the count-up draws on the video, and a
closed webview does not lose the clock.

## Purpose
Catches an app that loads but does not drive the real video: wrong colours, a missing
count-up, a leaked pile of saved backgrounds, or a timer that forgets itself when the
webview is torn down.

## Steps

### TC-01 · auto · App appears in Zoom
Do: Apps in the sidebar, open Toastmaster Timer.
Expect: it loads from the `zoom.` host (`zoom.timer-dev.simple-tech.app` on dev), not `www.`.
Evidence: `reqs.sh` shows the page load on the `zoom.` host.

### TC-02 · auto · Count-up on start, green at the threshold
Do: Live tab, pick "Table Topics: 1–1.5–2 min" (or any short role if the device hides it),
press Start with camera on.
Expect: elapsed time is drawn over the video at once and rises once a second (a virtual
foreground layer, not baked into the background). No colour card before the green threshold;
green from the green threshold.
Evidence: screenshot of the video frame; debug log shows one `setVirtualBackground` call.

### TC-03 · auto · Yellow then red at the thresholds
Do: let the speech run past 1:00 and then 2:00 (use `capture-timeline.sh`).
Expect: yellow at the yellow threshold, red at the red threshold, one background change each.
Never before the threshold: since #88 the tick rounds elapsed time down to the tenth.
Evidence: timeline shots with timestamps. Since #88, PostHog `card_color_applied` per change
(`detect_lag_ms`, `total_ms`, `frame_width` 384).
Last run (2026-11-01, dev cd97ad0, partial: overlay timing only, 1min role, not the whole spec):
every colour reached the video within one or two 30 fps frames of the sidebar's change;
`detect_lag_ms` 0-32, `zoom_reply_ms` 133-350. Log: test-runs/2026-11-01-overlay-timing/run.md.

### TC-04 · auto · Finish resets the video
Do: press Finish.
Expect: background removed or reset, count-up gone. Zoom may show its own reset prompt;
answer it (see the skill, "Zoom's own dialogs").
Evidence: screenshot after Finish.

### TC-05 · auto · No per-second backgrounds saved
Do: after the meeting, count the files in Zoom's backgrounds folder (see the skill's
`capture` notes), compared to the baseline taken before TC-02.
Expect: at most four new fixed colour backgrounds. None with a timestamp baked in.
Evidence: file count before and after.

### TC-06 · auto · Timer survives closing the app
Do: start a speech, run ~10 s, close the app with ⋯ → Close current app, wait ~5 s, reopen
from Apps. The Apps panel's own X only hides the app: Zoom keeps the webview, so there is no
reload and no toast (seen 2026-11-11).
Expect: a toast says the timer resumed; elapsed includes the closed seconds; card colour
matches the elapsed time (yellow if the threshold passed while closed).
Evidence: toast screenshot; saved timer state in `localStorage`.

### TC-07 · auto · Paused timer survives closing
Do: pause, close, reopen.
Expect: back paused at the same elapsed time; Continue carries on from there.
Evidence: `localStorage` timer state before and after.

### TC-08 · auto · Reset and Finish are not restored
Do: Reset, close, reopen.
Expect: 00:00, no toast. Same after Finish.
Evidence: no saved timer state in `localStorage`.

### TC-09 · human · Stale session is ignored
Do: leave a saved session over an hour old, then open the app at the next meeting.
Expect: starts at 00:00, no red card. (Needs an hour of waiting, or editing the saved
timestamp in `localStorage`, which the skill may do as a shortcut.)
Evidence: `localStorage` timestamp and the booted state.

### TC-10 · auto · Starting role when Standard Speech is removed
Do: with Standard Speech removed from the role list (Edit Rules, or a club publish without
it), open or refresh the app (⋯ → Refresh app) and press START without touching the role.
Expect: the role picker shows the first role in the list, the "Timing rules" line matches
that role, and START runs the timer. No "Please set timing rules first" warning.
Evidence: screenshot of the picker and the running timer; a `timer_started` event in
PostHog carrying that role.

### TC-11 · auto · timer_started carries the meeting's audience size (#107)
Do: as host, open the app first; if a second participant is available, let them join after
the app is open. Then press START on any role.
Expect: the `timer_started` event for this START has `audience_size` equal to the count in
Zoom's Participants panel at the moment of the press (late joiners included), alongside the
usual `speaker_name`, `role` and `timing_rules`. A host-only test meeting gives
`audience_size: 1`; that is accepted as proof the property is attached. No names leave the
device, only the number. The timer starts at once, not after the participant read.
Evidence: PostHog `timer_started` for this START (`audience_size`, `zoom_meeting_id`);
screenshot of Zoom's Participants count at the press. Note whether a second participant was
present.

### TC-12 · human · No audience_size for a non-host organizer (#107)
Do: a second Zoom account that is neither host nor co-host opens the app in the same meeting
and presses START.
Expect: the timer runs normally and `timer_started` is sent without `audience_size`. The debug
log shows one "Participant list needs host or co-host" warning for the press.
Evidence: PostHog `timer_started` from that account with no `audience_size`; debug log line.
Human because it needs a second signed-in Zoom account.

### TC-13 · auto · The Live tab does not time an agenda row that needs a role (#91)
Do: the device's built-in roles are not hidden (Standard Speech and Ice Breaker are in the role
dropdown). Agenda tab → Import Text → "Simple Format". Put these three lines on the clipboard
with `pbcopy`, click the textarea, paste with ⌘V, press Import.
```
Bob (Ice Breaker)
Alex (Table Topics)
Alice (Standard Speech)
```
Open the Live tab in Timer + Camera or Timer Only. Then:
1. Click the speaker name field and pick "Alex" from the Agenda suggestions.
2. Pick "Bob" the same way. Press Start, let it run about 5 s, press Finish (answer Zoom's
   reset prompt and the PostHog survey as the skill describes).
3. Display mode → Full-Screen Timer. Open the speaker list (the arrow beside the name on the
   stage) and pick "Alex". Open it again and pick "Alice".
Expect:
- After Import: toast "Imported 3 speaker(s). 1 needs a role"; on the Agenda tab only "Alex"
  is highlighted, with "(Table Topics) is not one of your roles".
- 1: a warning toast "Pick a role for Alex on the Agenda tab first". The name field stays
  empty and the role dropdown stays on Standard Speech.
- 2: Bob loads with Ice Breaker. After Finish the same toast shows, the name field is empty,
  and the role dropdown stays on Ice Breaker: not Standard Speech, and not Alex's text.
  Alex is not loaded.
- 3: the toast shows above the stage and the stage's name stays empty. Picking "Alice" puts
  "Alice" on the stage.
Evidence: screenshots of each toast with the name field and role dropdown (and the stage for
3). Page script (or on-screen rows if the inspector is off): `toastmaster_agenda` has Bob
`completed: true`, Alex with `role: "Table Topics"`, no `rules`, `completed: false`. PostHog
from this device: `speech_finished` for Bob with `role: "Ice Breaker"`, and no
`timer_started` with `speaker_name: "Alex"`.
Then: Display mode back to the one used before, and Clear All in the Agenda tab.

## Not covered
- Colour accuracy on every camera/background setting.
- A second participant seeing the video (needs a second computer).
- Choosing the background you return to between speeches. Its picker lives only in Card
  Images (`OwnBackgroundPicker.jsx`); the mode menu's "My Background…" item was removed.
- Sounds, opened from the speaker icon beside Card Images (always shown, locked unless
  the `sounds` flag is on and the account is Pro). See [timer-sounds](timer-sounds.md).
- Agenda import, and the roles it assigns to imported lines (`importBulkSpeakers` in
  `TimerContext.jsx`). See [agenda-import](agenda-import.md). Reviewed against #91
  (2026-11-13): that PR changes only `importBulkSpeakers` here; no step above uses it. Not
  rerun for it.
- A failed participant read at START (`timer_started` still sent, no `audience_size`). The
  Zoom client can't be made to fail it on demand; `LiveTab.test.jsx` covers it (#107 AC-5).
- A club card set arriving, changing or going away while the app is open. `LiveTab.jsx`
  re-pushes the current card then, and only then; a device with no club card set pushes
  exactly as above. See [club-card-sets](club-card-sets.md).
- A loaded agenda row whose role is removed (Edit Rules, or a club publish) while it is up:
  the Live tab lets go of the row with the same toast instead of moving it to the default
  role. A hand-picked role that leaves the list still moves to the default (TC-10's rule).
  Unit tests in both `LiveTab.test.jsx` files cover both; the client adds nothing.
- The web timer (`apps/web`) refuses the same rows from its suggestions and after FINISH.
  Unit tests in `apps/web/src/components/LiveTab.test.jsx`.
