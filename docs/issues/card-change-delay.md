# Card color change lags 1–2s behind the timer on slower computers

**Labels:** `bug`, `zoom-app`, `performance`

## Summary

A user reports that the timing card (green / yellow / red) changes on their video 1–2 seconds after the time actually reaches the threshold. We have seen the same thing before on a less powerful computer. On a fast machine the delay is not noticeable.

The timer itself is correct. The delay is between the app deciding the color has changed and Zoom showing that color on the user's video.

## Impact

- In Toastmasters, people are timed by the card. A card that turns red 1–2s late can change whether a speaker is counted as over time.
- It affects the default mode, **Timer + Camera**, so it likely reaches most users on slower hardware.
- It is invisible on fast machines, so we will not catch it in our own testing.

## How a color change works today

1. **Detection (local, about 0.1s).** The tick loop in `TimerContext.jsx` measures elapsed time from the system clock on every animation frame. When `calculateStatus()` returns a new color, it calls `applyOverlay()`. No server call is involved.
2. **Queueing.** `applyOverlay()` goes through `enqueueOverlayOp()` in `zoomSdk.js`. This queue runs **one Zoom update at a time**. Queued updates that are overtaken by a newer one are dropped, but **an update that has already started cannot be stopped**.
3. **Push to Zoom.**
   - **Timer + Camera:** `setVirtualBackground({ fileUrl })` with the card's URL. Zoom then swaps the virtual background behind the person, which is heavy work for the computer.
   - **Timer Only:** `setVideoFilter({ imageData })` with the decoded card pixels.
4. **Transmission.** Zoom sends the video to other participants (normal Zoom video delay; outside our control).

## Investigation

### Network: ruled out

Timer + Camera passes a URL to Zoom, so we checked whether each color change triggers a new download.

- Card images are served with `cache-control: public, max-age=31536000, immutable` and a version query (`?v=3`), and Cloudflare serves them from its cache.
- At startup, the app downloads and decodes all four cards once (`preloadBackgroundImages()`, called from `main.jsx`), in every mode.
- **Cloudflare analytics, 2026-09-25 to 2026-10-02, `/zoom/backgrounds/*` on simple-tech.app:**
  - 274 requests for the four built-in cards came from Zoom's web view (`ZoomApps/1.0`, on Mac, Windows and iPhone), across 52 client IPs.
  - No separate Zoom native downloader user agent appears at all.
  - Most user-days show **0–4 requests per color**; the busiest shows 13/8/7/7 (blue/green/yellow/red). A meeting times roughly 8–15 speeches, so re-downloading on every change would show about that many requests per color per meeting. The pattern matches a single download per app launch instead, with later launches often served from local cache.

**Conclusion:** each card is downloaded about once per app launch, then reused. Network speed does not explain the delay.

### Root cause: local processing, made worse by our update queue

Two causes, both on the user's machine:

**A. Color changes wait behind the count-up readout (our code).**

While a speech runs, the count-up readout redraws once a second (`setOverlayTimeLabel()` → `repaintOverlayFrame()`), through the **same one-at-a-time queue** as color changes.

- **Timer + Camera:** each second renders a transparent frame **at the camera's resolution** (`getForegroundBudget()`: 1280×720 by default, up to 1920×1080) and pushes it with `setVirtualForeground({ imageData })`. That is about **3.7MB of pixels per second at 720p (8.3MB at 1080p)** copied from the app's web view into Zoom, plus a full canvas render and `getImageData()`.
- **Timer Only:** each second re-renders the card with the readout baked in and pushes it with `setVideoFilter({ imageData })`.

When the threshold arrives, the color change has to wait for the readout update in progress to finish, then takes its own turn. On a machine where each update takes 0.5–1s, that adds up to the 1–2s reported. On a fast machine both take tens of milliseconds.

The per-second updates also keep the CPU busy, which slows down cause B.

**B. Zoom's own processing (not our code).**

Applying a new virtual background means Zoom re-composites the person over a new image in real time, while also encoding video and running any other effects. On a weak machine this takes noticeable time. We cannot make this faster directly; we can only reduce the competing work we add (see solution 2).

## Proposed solutions

### 0. Measure the delay on users' devices

Add timing to the overlay queue and send it to PostHog:

- **Queue wait:** from threshold detection to the moment the color update starts. This measures cause A directly.
- **Zoom response time:** from sending `setVirtualBackground` / `setVideoFilter` / `setVirtualForeground` to Zoom's reply.
- Properties: overlay mode, which Zoom call was used (`fileUrl` or pixels), readout visible or hidden, frame size.

Cost: microseconds per measurement (`performance.now()`). `posthog.capture()` only queues the event and sends it in the background, outside the overlay queue. Record the event after the color change has landed.

This gives us a before/after number for solutions 1 and 2, and shows how common the problem is.

**Limit:** the SDK has no "background is now showing" event, and the app cannot see its own outgoing video. We do not know whether Zoom replies *after* the new background is visible or *when it accepts* the request. We should calibrate this once: record the screen during a speech (using the `zoom-app-testing` skill) and compare the frame where the color changes with the logged reply time.

### 1. Keep the queue clear before each threshold (fixes cause A)

The green / yellow / red thresholds are known in advance (`speaker.rules`). Pause readout updates for about 1.5s before each upcoming threshold, and resume once the color update has landed.

- **Effect:** the color change never waits behind a readout update. This should remove most of cause A.
- **Trade-off:** the readout pauses for a second or two around each threshold, then jumps ahead. Attention is on the color at that moment, so this should be barely noticeable.
- **Scope:** a check in the tick loop in `TimerContext.jsx` (skip `setOverlayTimeLabel()` when the next threshold is within the window), and resume after the status change. Pausing and resuming the timer needs no special handling, because the check uses elapsed time.
- **Tests:** a tick just before a threshold does not push a readout; the color update runs immediately; readout updates resume afterwards.

### 2. Adapt the readout rate to the machine (reduces cause B)

Use the timing from solution 0. If readout updates regularly take longer than about 0.5s, refresh every 2–5 seconds instead of every second. Go back to every second if updates get faster again.

- **Effect:** frees CPU for Zoom's background processing on weak machines, and makes the queue busy less often.
- **Trade-off:** on slow machines the readout moves in steps rather than every second. Fast machines see no change.

## Rejected: sending the color change early

We considered measuring the delay and sending each color change that much earlier, so it lands on time. **Rejected:** a card that shows early is as wrong as one that shows late, and an estimate that is off would make the card change before the speaker reached the threshold. The card should change no earlier than the actual threshold.

## Workarounds for affected users (until fixed)

- Hide the count-up readout. This stops the once-a-second updates, so the color change does not wait behind them.
- Switch to **Timer Only** or **Stage** mode. Stage mode uses no video processing and is the fastest.
- Close other heavy apps, and turn off heavy Zoom effects (touch-up, studio effects).

## Acceptance criteria

- [ ] PostHog events report queue wait and Zoom response time for each color change.
- [ ] With the readout visible, the queue wait for a color change is near zero on a slow machine (no readout update in progress at the threshold).
- [ ] On a fast machine, the readout behaves as before apart from the short pause around thresholds.
- [ ] The card never changes before the threshold.
- [ ] One screen-recording calibration run shows how Zoom's reply time compares with when the color is actually visible.
