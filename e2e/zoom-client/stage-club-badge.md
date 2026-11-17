---
id: stage-club-badge
title: Club badge on the Full-Screen Timer stage
status: stale
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
  - FLAGS_FORCE "1" on dev (`pro` on: the badge is a club feature, see club-pro-gate)
  - a club device whose club is active (Claude Test Club on the test Mac), with "Show on
    cards" on, and the badge at the club position (Live tab preview → "Reset to club
    position" if it was moved)
verified_at: never
verified_on: never
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
Expect: on the stage the badge is in the top-right corner of the card band (the Toastmasters
logo is in its top-left corner), wholly inside the band and the panel. Its width is about the
same share of the band's width as of the video frame's (within 5 points; ~28% for "Claude Test
Club"). Its height is ~12% of the band's height. Nothing of it is on or behind Close,
Screenshare, the pop-out button, the speaker row, the clock, START or Reset.
Evidence: the two snaps, with the badge, band and frame widths measured in view pixels and
the shares logged.

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
Do: on the stage, press the pop-out button ("Open in its own window"). Resize the popped-out
window to about 16:9 or wider (drag its bottom-right corner). Snap it. Merge back.
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
- 2026-11-16, `fix/stage-club-badge-size` (#165): blocked, not run. Dev and the test Mac were held
  by the design-B Zoom pass, and wrangler's Cloudflare login on the Mac had expired, so the
  branch could not be deployed to dev.

## Not covered
- What other participants see when the stage is shared: the share is the panel itself, so
  SB-01 is the same pixels, and one test Mac cannot be a second participant.
- The badge on the video (canvas): [club-pro-gate](club-pro-gate.md) GP-03 and the club Pro
  plan (`pro-club`, not migrated yet).
- The preview tile's own badge proportions (`TimerDisplay`): not part of this spec.
