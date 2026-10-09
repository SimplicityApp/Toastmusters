---
id: timer-core
title: Core timer in the Zoom client
status: draft
covers:
  - apps/zoom-app/src/context/TimerContext.jsx
  - apps/zoom-app/src/components/LiveTab.jsx
  - apps/zoom-app/src/utils/zoomSdk.js
  - packages/shared/clubBadge.js
automated:
  - e2e/zoom.timer-flow.spec.js
  - apps/zoom-app/src/utils/zoomSdk.test.js
needs:
  - dev deployed
  - camera on, in a meeting
verified_at: never
verified_on: never
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

### TC-02 · auto · Green on start, count-up on video
Do: Live tab, pick "Table Topics: 1–1.5–2 min", press Start with camera on.
Expect: background turns green; elapsed time is drawn over the video and rises once a second
(a virtual foreground layer, not baked into the background).
Evidence: screenshot of the video frame; debug log shows one `setVirtualBackground` call.

### TC-03 · auto · Yellow then red at the thresholds
Do: let the speech run past 1:00 and then 2:00 (use `capture-timeline.sh`).
Expect: yellow at the yellow threshold, red at the red threshold, one background change each.
Evidence: timeline shots with timestamps.

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
Do: start a speech, run ~10 s, close the app with X (not the back arrow), wait ~5 s, reopen.
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

## Not covered
- Colour accuracy on every camera/background setting.
- A second participant seeing the video (needs a second computer).
