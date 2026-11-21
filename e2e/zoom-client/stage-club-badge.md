---
id: stage-club-badge
title: Club badge on the Full-Screen Timer stage
status: current
covers:
  - apps/zoom-app/src/components/TimerStage.jsx
  - apps/zoom-app/src/utils/stageBadgeLayout.js
  - packages/ui/ClubBadge.jsx
automated:
  - apps/zoom-app/src/utils/stageBadgeLayout.test.js
  - packages/shared/__tests__/clubBadge.test.js
  - e2e/zoom.stage-badge.spec.js
needs:
  - dev deployed
  - FLAGS_FORCE "1,new_look=0" on dev (`pro` on: the badge is a club feature, see
    club-pro-gate; `new_look` off for today's panel)
  - a club device whose club is active (Claude Test Club on the test Mac), with "Show on
    cards" on, and the badge at the club position (Live tab preview → "Reset to club
    position" if it was moved)
verified_at: 5cabd42
verified_on: 2026-11-16 (Zoom 7.2.5, macOS 26.7.2, dev d5237c66 with FLAGS_FORCE "1")
---

# Club badge on the Full-Screen Timer stage

The stage (Display mode → Full-Screen Timer) is the sidebar panel itself, shared into the
meeting or popped out. It shows the 16:9 card artwork contained in the panel: on the tall,
narrow sidebar that is a band across the middle, with blurred artwork above and below. The
club's badge belongs to that card. Its size and spot are the same shares of the card as on
the video, and it stays off the stage controls: Close, Screenshare, the pop-out button and the
speaker row at the top; the clock, START and Reset at the bottom.

## Purpose
Catches the badge being sized against the panel instead of the card. On 2026-11-16 (dev,
Claude Test Club, panel ~400px wide) it was over half the panel wide, ran off the right edge
and sat across Screenshare and the pop-out button, while the same badge on the 16:9 video was
about 28% of the frame. Also catches a badge dragged into a corner leaving the card, and a
wide popped-out window putting the badge under the controls.

## Steps

### SB-01 · auto · On the sidebar panel the badge sits on the card, at the video's size
Do: Display mode → Card mode (or Camera) and snap your own video. Then Display mode →
Full-Screen Timer, at the panel's default width, and snap the panel.
Expect: on the stage the badge is in the top-right corner of the card band, wholly inside the
band and the panel. Its height is the same share of the band's height as of the video frame's
(within 1 point; ~12% at the default scale), and its centre is at the same fractions of the
card (within 0.02; (0.80, 0.12) by default). Nothing of it is on or behind Close, Screenshare,
the pop-out button, the speaker row, the clock, START or Reset. Its width is only comparable
when both draw the same content: the stage badge draws the club logo, and the video badge may
not (2026-11-16: 36.4% of the band with the logo, 30.5% without, 28.3% on the name-only video).
Evidence: the two snaps, with the badge, band and frame sizes measured on the full-resolution
shots and the shares logged.

### SB-02 · auto · A moved, bigger badge lands on the same spot of the card
Do: Display mode → Card mode. On the Live tab preview, drag the badge to the bottom left and
press + twice. Open Full-Screen Timer and snap it. Then back on the preview, "Reset to club
position".
Expect: on the stage the badge is in the bottom-left corner of the card band, bigger than in
SB-01 by the same factor as on the preview, inside the band, and above the clock row. After
the reset it is back at the top right.
Evidence: snaps of the preview and the stage; `toastmaster_club_badge` in localStorage
before and after the reset if a page script can read it.

### SB-03 · auto · In a wide popped-out window the badge stays off the controls
Do: on the stage, press the pop-out button ("Open in its own window"). If the popped-out window
is narrower than 16:9, resize it to about 16:9 or wider (drag its bottom-right corner); on
2026-11-16 it opened at 1152×696 pt, already wider. Snap it. Merge back.
Expect: the card fills the window's height. The badge keeps ~12% of the window's height and
its x (top right of the card), and sits just below the Screenshare row instead of under it.
It never overlaps the controls. If Zoom will not resize the window, log ⏭ with the reason:
the e2e test covers the geometry at 1280×720.
Evidence: snap of the wide window.

### SB-04 · auto · A hidden badge stays off the stage
Do: on the Live tab preview, hide the badge (its eye button). Open Full-Screen Timer. Then
show it again.
Expect: no badge on the stage while hidden; it is back in SB-01's spot once shown.
Evidence: snaps.

## Runs
- 2026-11-16 (02:00Z on the 17th), `fix/stage-club-badge-size` 5cabd42 (#165), dev d5237c66 with
  FLAGS_FORCE "1", Claude Test Club device with the "CLUB BLUE" club card set: SB-01…SB-04
  passed. Sidebar stage 360×850 pt, card band 360×202.5 pt; badge 11.9% of the band's height
  (video 11.7%), centre (0.80, 0.11) (video (0.80, 0.12)). SB-02 at 16.0% after + twice, bottom
  left, inside the band. SB-03 pop-out at 1.87:1: 12.1% of the card height, x 0.80, moved down
  just below the Screenshare row. Log: test-runs/2026-11-16-stage-club-badge/run.md. An earlier
  attempt the same day was blocked (dev and the Mac held, wrangler login expired).

## Not covered
- What other participants see when the stage is shared: the share is the panel itself, so
  SB-01 is the same pixels, and one test Mac cannot be a second participant.
- The badge on the video (canvas): [club-pro-gate](club-pro-gate.md) GP-03 and the club Pro
  plan (`pro-club`, not migrated yet).
- The preview tile's own badge proportions (`TimerDisplay`): not part of this spec.
- The stage under design B (`new_look` on). Reviewed against the merge that brought design B
  in (9cb4e5f): there `TimerStage.jsx` only renames the share button "Share to the meeting".
  The badge keeps clear of the whole controls row (`topInset`), not of the button's width, so
  the longer label moves nothing here. [new-look](new-look.md) NL-18 opens that stage.
- A custom card wider than 16:9. Uploads keep their aspect (scaled to fit 1280×720), and the
  stage contains the artwork, while the badge sits on the stage's 16:9 band. For a 16:9 or a
  taller card that is the part of the artwork the video shows; for a wider card the badge sits
  a little off the artwork. Every card seen so far is 16:9.
