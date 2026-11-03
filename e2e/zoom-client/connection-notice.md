---
id: connection-notice
title: Guest-mode notice when Zoom has not approved the app, at open and mid-session (#85)
status: draft
covers:
  - apps/zoom-app/src/components/ZoomConnectionNotice.jsx
  - apps/zoom-app/src/utils/zoomConnection.js
automated:
  - apps/zoom-app/src/components/ZoomConnectionNotice.test.jsx
needs:
  - dev deployed
  - a second Zoom account in the `authenticated` state, in a meeting with the owner (docs/ZOOM_AUTH_AND_REDIRECTS.md, "Reaching the authenticated state deliberately")
  - camera on, Timer + Camera mode
verified_at: never
verified_on: never
---

# Guest-mode notice when Zoom has not approved the app, at open and mid-session (#85)

Migrated from `docs/ZOOM_TEST_PLAN.md` Steps 1c and 1e.

## Purpose
A user signed into Zoom whose grant is missing or lapsed is `authenticated`, not `authorized`:
the app still opens, but Zoom asks "Allow" on every colour change. Catches an app that never
offers the in-client fix, and (since #85) one that misses a grant dropped while the panel is
already open, or covers a running speech with the modal.

## Steps

### CN-01 · human · Notice at open
Do: as the `authenticated` account, open the app in the meeting from the App Launcher.
Expect: amber banner "Zoom asks permission on every color change until you approve this app",
and the "Approve Toastmusters Timer in Zoom" modal once per session.
Evidence: screenshot; PostHog `zoom_connection_degraded` with `connection_state: unauthorized`,
`detected: on_open`.

### CN-02 · human · Approve in the client clears it
Do: click **Approve in Zoom**, then approve in Zoom's own prompt.
Expect: Zoom's prompt opens inside the client (no browser tab); after approving, the banner
goes and the "Approved" toast shows. A new speech changes colour with no "Allow" dialog.
Evidence: debug log `User context changed; Zoom now reports the user as authorized`; PostHog
`zoom_reauthorized`.

### CN-03 · human · Grant dropped mid-session raises the banner
Do: as an `authorized` user, start a speech, then drop the grant while the timer runs (remove the
app for that account in the Marketplace, or switch to the guest-mode state).
Expect: if the client fires `onMyUserContextChange`, the amber banner appears at once and no
modal covers the running timer. If nothing appears and the log has no `User context changed`
line, the client did not fire the event: record the date and client version in
`docs/ZOOM_AUTH_AND_REDIRECTS.md` (status-contract assumptions); the drop is caught at next open.
Evidence: debug log; PostHog `zoom_connection_degraded` with `detected: mid_session`.

### CN-04 · human · The modal waits for the speech to end
Do: after CN-03, click **Stop**.
Expect: the modal opens now, unless it was already closed once in this Zoom session (then only
the banner stays).
Evidence: screenshot.

## Not covered
- A client that refuses `promptAuthorize` (the button falls back to the OAuth URL in the
  browser and logs `promptAuthorize not granted`): needs an older client.
- Web sign-in's `scope_not_granted` outcome: website only, covered by `worker/auth.test.js`
  and `SignInFailureActions.test.jsx`.
