---
id: pro-coming-soon
title: Footer Pro button before the launch (locked, "Pro is coming soon")
status: current
covers:
  - apps/zoom-app/src/components/ProComingSoon.jsx
  - apps/zoom-app/src/components/Footer.jsx
automated:
  - apps/zoom-app/src/components/ProComingSoon.test.jsx
  - apps/zoom-app/src/components/Footer.test.jsx
  - e2e/zoom.pro-coming-soon.spec.js
needs:
  - dev deployed
  - FLAGS_FORCE "0" on dev (`pro` off) for PC-01 to PC-03; "1" for PC-04
  - since plan 13, FLAGS_FORCE "1" also turns on `new_look` (design B); these steps are written for
    today's panel, so wherever they say "1", deploy "1,new_look=0" ("0" already has it off)
verified_at: 61de1d8
verified_on: 2026-11-19 (Zoom 7.2.5, macOS 26.7.2, dev 0aa7a2d0 with FLAGS_FORCE "0" and 0ac2f458 with "1,new_look=0"; 61de1d8 + dev c42fbbf merged locally)
---

# Footer Pro button before the launch (locked, "Pro is coming soon")

While `pro` is off, the footer keeps a Pro button in its usual place, greyed with a small
lock. Pointing at it, or clicking it, opens a short list of what Pro will bring. Once `pro`
is on, it is the real Pro / Upgrade button again.

## Purpose
Catches a footer that no longer fits on one line in the 400px panel, a list that opens off
screen or under other content in the Zoom webview, a hover that never closes, and a locked
button that survives the launch.

## Steps

### PC-01 · auto · A locked Pro button sits in the footer while `pro` is off
Do: with FLAGS_FORCE "0" on dev, open the app from Apps and look at the footer.
Expect: "Send Us Feedback", "Review" and a grey "Pro" with a lock in place of the sparkle, all
on one line. No "Upgrade" anywhere in the footer.
Evidence: screenshot of the footer.

### PC-02 · auto · Pointing at it lists what is coming
Do: point at the locked Pro button, then move the pointer away.
Expect: a white card opens above the button, inside the panel: "Pro is coming soon", then
three ticked lines (sounds; club card sets on every club timer; voting for Best Table
Topics and Best Evaluator), "And more: your club's logo, shared timings, meeting history."
and "The timer itself stays free." It closes when the pointer leaves.
Evidence: screenshot with the card open; PostHog `pro_coming_soon_opened` with
`trigger: "hover"`.

### PC-03 · auto · A click keeps the list open
Do: click the locked Pro button, move the pointer away, then click on the Live tab's
"Timing Role" label.
Expect: the card stays open after the pointer leaves, and closes on the click elsewhere.
Nothing else happens on that click.
Evidence: screenshots; PostHog `pro_coming_soon_opened` with `trigger: "click"`.

### PC-04 · auto · The real Pro button is back once `pro` is on
Do: set FLAGS_FORCE "1" on dev and reopen the app.
Expect: no lock. A Pro device shows the amber "Pro" button; a free device shows "Upgrade",
with a small red dot on it until the Pro announcement has been looked at (see
[pro-launch](pro-launch.md); reviewed 2026-11-14 when #144 merged dev, not rerun for it).
Evidence: screenshot of the footer.

## Not covered
- The web app, whose header has no Pro button of this kind.
- Touch: the Zoom desktop client is mouse-driven, and a click works the same as a tap.
- Reviewed against #167: `Footer.jsx` now fetches the Upgrade dialog right after the first
  paint, and the Review button's accessible name is "Review Toastmusters Timer on the Zoom App
  Marketplace" (its visible "Review" is unchanged). No step here moves.

Run 2026-11-19 (claude/redesign-b-p3 61de1d8 with dev c42fbbf merged locally (83fc093, not pushed)): PC-01, PC-02 and PC-03 passed with FLAGS_FORCE "0"; PC-04 passed
with "1,new_look=0" on a Pro device (amber "Pro"; the device is personal Pro since it dropped
out of its club). The free-device half of PC-04 (Upgrade with the dot) not run: no free device.
Log: test-runs/2026-11-19-design-b-stack-final/run.md.
