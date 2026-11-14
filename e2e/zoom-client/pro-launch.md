---
id: pro-launch
title: Pro launch announcement
status: current
covers:
  - apps/zoom-app/src/components/ProLaunchModal.jsx
  - apps/zoom-app/src/components/PeriodicPrompts.jsx
  - apps/zoom-app/src/components/Footer.jsx
  - packages/shared/promptScheduler.js
automated:
  - e2e/zoom.pro-launch.spec.js
  - apps/zoom-app/src/components/PeriodicPrompts.test.jsx
  - apps/zoom-app/src/components/Footer.test.jsx
  - packages/shared/__tests__/promptScheduler.test.js
needs:
  - dev deployed with `VITE_ENABLE_DEBUG_PANEL=true` (PL-02, PL-03 use the debug panel's prompt controls)
  - FLAGS_FORCE "1" on dev (the announcement is behind `pro`)
  - camera on, in a meeting
  - PL-04 only, a Zoom account on the Free plan with no club on the device
verified_at: eeaa840
verified_on: 2026-11-13 (Zoom 7.2.5, macOS 26.7.2, dev c8774483)
---

# Pro launch announcement

## Purpose
Once the `pro` flag is on, a free device gets a one-time "New: Pro for your club" window
after a speech ends, and the footer's Upgrade button carries a red dot until the user has
looked at Pro. Playwright proves the gates and the once-only rule with the SDK mocked. Only
the real client shows that the window fits the narrow Zoom panel, lands after FINISH rather
than over a running speech or Zoom's own background prompts, and hands off to the real
Upgrade dialog in Zoom's webview.

## Steps

### PL-01 · auto · Footer dot in the Zoom panel
Do: open the app on a device that is not Pro, with the `pro` flag on.
Expect: the footer reads "Send Us Feedback", "Review", "Upgrade" on one line where the panel is
wide enough, and the sparkle icon on Upgrade carries a small red dot. On a Pro device the
button reads "Pro" with no dot.
Evidence: screenshot of the footer; for a Pro device, which plan the panel shows.

### PL-02 · auto · The window in the Zoom panel, and the hand-off to Upgrade
Do: debug panel → Periodic Prompts → "Pro launch" → Show. Then "See what's in Pro", and close
the Upgrade dialog.
Expect: the window "New: Pro for your club" fits the panel with no horizontal scroll: three
bullet lines, four with "A chime when the card changes, and music during breaks" while the
`sounds` flag is on (it is, under FLAGS_FORCE "1"), "The timer itself stays free. Not the one who decides? Tell your club officers.",
and the buttons "Not now" and "See what's in Pro". "See what's in Pro" replaces it with the
Upgrade dialog (its benefit list starts "Your club's brand kit on every timer card and report"
on a free device; a Pro device sees its own plan). After closing, the debug panel reads
"Pro launch: 0/1 asks, answered" (a forced show records no ask) and the footer dot is gone.
Evidence: screenshots; PostHog from this device: `pro_launch_learn_more`, then
`upgrade_prompt_shown` with `source: "pro_launch"`.

### PL-03 · auto · A Pro device is not told about Pro
Do: on a device that is Pro (a club code or a subscription), debug panel → Reset history, then
time one short speech and press FINISH. Wait 5 s.
Expect: no announcement. The debug panel reads "Pro launch: 0/1 asks". No other prompt is due
after a single speech.
Evidence: screenshot after the wait; PostHog has no `periodic_prompt_shown` with
`prompt: "pro_launch"` from this device for the run.

### PL-04 · human · A free device sees it once, after FINISH
Do: sign in to Zoom with a Free account that has no club on the device. With prompt history
reset (debug panel), START a speech, wait for green, FINISH. Answer Zoom's background prompt if
it shows. Wait 3 s. Close the window with "Not now". Time and finish another speech.
Expect: nothing appears while the timer runs or on the FINISH click itself; about 2.5 s after
FINISH the window appears. After "Not now" the footer dot stays. The second speech brings no
window back; the debug panel reads "Pro launch: 1/1 asks".
Evidence: screenshots; PostHog `periodic_prompt_shown` and `periodic_prompt_dismissed` with
`prompt: "pro_launch"`, once each.
Human because it needs a second, Free Zoom account signed in on the test computer.

Run 2026-11-13 (eeaa840, Zoom on macOS, device Pro through its own subscription): PL-02 and
PL-03 passed; PL-01 only its Pro half (no dot on "Pro"); PL-04 not run (needs a Free account).
Log: test-runs/2026-11-13-pro-launch/run.md.

## Not covered
- The purchase and club-code flows inside the Upgrade dialog (the pro-club area is not
  migrated to a spec yet; see `INDEX.md`).
- The web timer: it has no Pro announcement. Its prompts are unchanged.
- The 28-day end of the footer dot (`PRO_LAUNCH_BADGE_DAYS`): unit-tested with a pinned clock.
- A link for club officers: there is no page about Pro on the website to point at yet.
