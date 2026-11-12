# Timer reach metric: attach audience_size to timer_started events (#107)

## Problem
`timer_started` counts operator presses, not people served: a class of 20 where the teacher
presses START 15 times looks like 15 solo web starts. Analytics (`traffic_report.py`, the
PostHog "Timer reach (daily)" insight) is already waiting for an `audience_size` property on
`timer_started` from the Zoom app. Only a count leaves the device, never names.

## Findings
- `apps/zoom-app/src/components/LiveTab.jsx:601` `handleStart`; the event is sent at
  `:634-642` inside `(window.requestIdleCallback || setTimeout)(...)` with `speaker_name`,
  `role`, `timing_rules`. It is the only `timer_started` in the Zoom app (`handleContinue`
  at `:645` sends `timer_continued`).
- `apps/zoom-app/src/utils/zoomSdk.js:4444` `getZoomParticipants()` awaits SDK init, then
  merges `getUserContext` (self) with `getMeetingParticipants` (everyone else), deduped. It
  returns `{ participants, role, restricted }`; with no SDK it returns `participants: []`,
  `restricted: false` (`:4452-4455`). `restricted` is true only when the list call failed
  and the role is known and not host/co-host (`:4498-4499`). It does not throw on API
  errors; `initializeZoomSdk()` is the only await that could.
- `apps/zoom-app/src/hooks/useZoomParticipants.js:18` fetches once per mount and never
  refreshes. `LiveTab` mounts when the app opens, so a hook count misses late joiners (the
  owner's comment on the issue). The hook is not used.
- `zoom_meeting_id` is already registered on every event as a session property
  (`apps/zoom-app/src/main.jsx:101-105`), which is what the report groups reach by. No change.
- Web timer: `apps/web/src/components/LiveTab.jsx:203` sends `{ role, speaker_name }` and has
  no Zoom SDK. No change needed there; AC-4 only pins it down.
- Tests: `apps/zoom-app/src/components/LiveTab.test.jsx` already mocks `getZoomParticipants`
  (`:42`) and `trackEvent` (`:47`) and uses fake timers (`:87`); nothing asserts on
  `timer_started` yet. `apps/web/src/components/LiveTab.test.jsx` exists.
- Zoom-client spec `e2e/zoom-client/timer-core.md` covers `LiveTab.jsx` and `zoomSdk.js`;
  TC-10 already checks a `timer_started` in PostHog, so there is precedent for event evidence.
  `timer-sounds.md` also lists `LiveTab.jsx`; its steps don't involve the event.

## Approach
In `handleStart`, keep `startTimer()` synchronous and unchanged. In the idle callback, call
`getZoomParticipants()`, then send `timer_started` with the existing properties plus
`audience_size: participants.length` only when `!restricted && participants.length > 0`.
If the fetch rejects, send the event without the property (`.catch` → empty result), so a
failed participant read never loses a start. Capture `speakerName`/`selectedRole`/`rules`
before the await (they already are, by closure). About 10 lines in one file.

Rejected:
- `useZoomParticipants()` in `LiveTab` (the issue's original diff): count frozen at app open,
  and a third mount-time fetch.
- Polling or subscribing to participant changes: more SDK traffic for a number only needed
  at START.
- Sending `audience_size: 0` or `1` when withheld: the issue wants it omitted, and analytics
  already treats missing as 1.
- Adding it to `speech_finished` / `timer_continued`: out of scope for the issue.

## Acceptance criteria
- AC-1: Given the app runs in a Zoom meeting as host or co-host and `getZoomParticipants`
  reports N ≥ 1 participants with `restricted: false`, when the organizer presses START,
  then `timer_started` carries `audience_size: N` alongside the unchanged `speaker_name`,
  `role` and `timing_rules`.
- AC-2: Given the participant count changes after the app opened (people join), when START
  is pressed, then `audience_size` is the count read at START, not at mount.
- AC-3: Given the organizer is neither host nor co-host (`restricted: true`), when START is
  pressed, then `timer_started` is sent without `audience_size`.
- AC-4: Given no Zoom SDK (the Zoom app in a plain browser, or the web timer at
  `apps/web`), when START is pressed, then `timer_started` is sent without `audience_size`.
- AC-5: Given `getZoomParticipants` rejects, when START is pressed, then the timer still
  starts immediately and `timer_started` is still sent, without `audience_size`. *(proposed)*
- AC-6: Given the build is released to production, the PostHog "Timer reach (daily)"
  insight shows reach above starts on days with multi-person meetings. *(post-release;
  not checked by this PR)*

## Test list
| AC | Unit | Playwright | Zoom-client spec |
|---|---|---|---|
| AC-1 | `apps/zoom-app/src/components/LiveTab.test.jsx`: mock 3 participants, START, run idle timer, `trackEvent` called with `timer_started` incl. `audience_size: 3` and the old props | — | `timer-core` NEW TC-11 (auto): host presses START; PostHog `timer_started` has `audience_size` equal to Zoom's Participants count |
| AC-2 | same file: mock returns 1 participant first, 4 after render; START → `audience_size: 4`, and `getZoomParticipants` called after the press | — | `timer-core` TC-11 (open the app first, then a second participant joins if available; else note it) |
| AC-3 | same file: `restricted: true` with self only → no `audience_size` key | — | `timer-core` NEW TC-12 (human): second Zoom account, not host/co-host, presses START; event has no `audience_size` |
| AC-4 | same file: `participants: []` → no key. `apps/web/src/components/LiveTab.test.jsx`: `timer_started` props have no `audience_size` | existing `e2e/zoom.timer-flow.spec.js` START flow keeps passing (no SDK path) | — |
| AC-5 | same file: `getZoomParticipants` rejects → `timer_started` still sent without the key; timer running right after the click | — | — |
| AC-6 | — | — | — (post-release; listed under "Not verified" in the PR) |

Spec edit: add TC-11 and TC-12 to `e2e/zoom-client/timer-core.md` (no renumbering), update
the INDEX row's "Covers" text, run `npm run test:specs`.

## Risk
Low. Analytics-only change in `apps/zoom-app/src/components/LiveTab.jsx`; START itself is
not touched, and the event path catches its own failure. One extra
`getUserContext`/`getMeetingParticipants` pair per START (a non-host gets a logged warning
per START). No `config.json` `riskHigh` paths.

## Open questions
- Q1: The acceptance criteria are the issue's, rewritten as Given/When/Then; AC-2 and AC-5
  are new (AC-2 from the owner's comment, AC-5 proposed). Default: keep all six.
- Q2: Does deriving a participant count from `getMeetingParticipants` need a line in the
  privacy policy or the Marketplace data-use answers? Only a number leaves the device.
  Default: no policy change in this PR; flag it in the PR's "Not verified" for the human.
- Q3: The dev test meeting usually has only the host, so TC-11 would see `audience_size: 1`.
  Default: accept 1 as proof the property is attached (it matches Zoom's own count); AC-2 is
  proven by the unit test, and TC-11 checks a larger count only if a second participant is
  present.
- Q4: A non-host gets one "Participant list needs host or co-host" warning in the debug log
  per START. Default: accept it; don't add a cache or role pre-check.
