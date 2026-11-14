---
id: pro-coming-soon
title: Footer Pro button before the launch (locked, "Pro is coming soon")
status: draft
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
verified_at: never
verified_on: never
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
Expect: no lock. A Pro device shows the amber "Pro" button; a free device shows "Upgrade".
Evidence: screenshot of the footer.

## Not covered
- The web app, whose header has no Pro button of this kind.
- Touch: the Zoom desktop client is mouse-driven, and a click works the same as a tap.
