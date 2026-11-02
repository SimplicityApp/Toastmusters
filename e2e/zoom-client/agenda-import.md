---
id: agenda-import
title: Simple Format import assigns custom roles in the Zoom client
status: draft
covers:
  - packages/shared/simpleFormatParser.js
  - apps/zoom-app/src/context/TimerContext.jsx
  - apps/zoom-app/src/components/AgendaTab.jsx
automated:
  - packages/shared/__tests__/simpleFormatParser.test.js
  - apps/zoom-app/src/context/TimerContext.test.jsx
  - e2e/zoom.timer-flow.spec.js
needs:
  - dev deployed
  - camera on, in a meeting
  - club presets not live on this device (not in a club, or "Use mine" in Edit Rules)
  - no custom roles on the device before IM-01 (note and remove any in the run log)
verified_at: never
verified_on: never
---

# Simple Format import assigns custom roles in the Zoom client

Added for #77 (PR #93). Agenda → Import Text → Simple Format reads the role from the last
`(...)` group and matches it against the custom roles in the role dropdown: exact first, then
the closest whole-word match. The parser is unit-tested. This spec proves the deployed Zoom
build does the same with text pasted into the real webview, and that an imported custom role
drives the video with its own thresholds.

## Purpose
Catches an import that still drops custom roles to Standard Speech (5/6/7 min) on a line that
has a speaker name. The club then sees a red card minutes late on real video. It also catches
a paste that does not reach the Zoom webview's textarea.

## Steps

### IM-01 · auto · Custom roles saved in Edit Rules
Do: Live tab → "Edit timing rules" → "Add role" three times, then Save Changes:
`Opening` green 0:15 / yellow 0:30 / red 0:45; `Closing Remarks` 1:00 / 1:30 / 2:00;
`Hand over` 0:30 / 0:45 / 1:00.
Expect: the Live tab role dropdown lists the three after the built-ins, in that order.
Evidence: page script: `localStorage.toastmaster_role_order` is
`["Opening","Closing Remarks","Hand over"]`, and `toastmaster_role_rules.Opening` has
`green: 15, yellow: 30, red: 45` (seconds).

### IM-02 · auto · Simple Format paste lands each line on the right role
Do: Agenda tab → Import Text. The modal opens on EasySpeak, so pick the "Simple Format" tab.
Put these six lines on the clipboard with `pbcopy` (`cliclick t:` cannot type newlines). Click
the textarea, paste with ⌘V, then press Import.
```
Cam-Ly - Opening (Opening)
Dominique - General Evaluation (Closing)
Yu (Closing Remarks - 2 min)
Sam - Introduce Speakers (hand over)
Bob (Ice Breaker)
Lee (Moment of Reflection)
```
Expect: toast "Imported 6 speaker(s)". The agenda shows these rows in this order (the
"before #77" column is the old result, so a row with that role is the bug):

| Row name | Role shown | Why | Before #77 |
|---|---|---|---|
| Cam-Ly - Opening | Opening | exact match | Standard Speech |
| Dominique - General Evaluation | Closing Remarks | bracket wins over the name's keywords; partial match | General Evaluation |
| Yu | Closing Remarks | decorated bracket contains the role | Standard Speech |
| Sam - Introduce Speakers | Hand over | case-insensitive | Standard Speech |
| Bob | Ice Breaker | built-in, unchanged | Ice Breaker |
| Lee | Short Roles | no custom match, old detection | Short Roles |

Evidence: page script: `toastmaster_agenda` has six items with those `name` / `role` values,
and each custom item's `rules` equals that role's entry in `toastmaster_role_rules`. In
PostHog, the `agenda_imported` event from this device has `import_type: "bulk"`,
`items_count: 6` and `custom_role_count: 4`.

### IM-03 · auto · An imported custom role drives the video colours
Do: Agenda tab → click the "Cam-Ly - Opening" row (it opens the Live tab with that speaker).
Check that the role dropdown shows "Opening". Then press Start with the camera on and run
`capture-timeline.sh` with shots at about `8:blue 20:green 36:yellow 50:red`.
Expect: no colour before 0:15, then green from 0:15, yellow from 0:30 and red from 0:45.
These are Opening's thresholds. Standard Speech would stay uncoloured for the first 5:00.
Evidence: timeline shots with timestamps. The debug log shows one `setVirtualBackground`
call per colour change.
Reviewed against #88 (2026-11-01): the tick now rounds down to the tenth and duplicate pushes
join; the thresholds and one call per change above still hold. Not rerun.

### IM-04 · auto · Cleanup
Do: Finish the speech (answer Zoom's reset prompt and the PostHog survey, as the skill
describes). In the Agenda tab, press Clear All and confirm. In Edit timing rules, remove the
three roles from IM-01 and press Save Changes.
Expect: the agenda is empty and the dropdown has no custom roles. Other specs see a clean
device.
Evidence: page script: `toastmaster_agenda` is empty or absent, and
`toastmaster_role_order` is `[]`.

## Not covered
- Custom roles that come from Club Pro presets, or from older saved rules with no role
  order. The PR now covers these too (`customRoleNames` comes from the dropdown, not from
  `customRoleOrder`). Unit test: `TimerContext.test.jsx` "imports a custom role whose rules
  were saved without a role order". A real-client step belongs in `pro-club` once that spec
  is migrated.
- Tie-breaks between custom roles, whole-word-only matching, and the built-in guard (a
  bracket like `(Ice Breaker)` is never taken by a partial custom match). Unit tests in
  `simpleFormatParser.test.js` cover these, and the client adds nothing to them.
- EasySpeak import. This change did not touch it, and it has no spec yet.
- `(Table Topics Speech)` imports as a `Table Topics` role with no timing rules (#91). A
  built-in keyword in the name overrides a built-in role in the bracket (#90). Both are
  known open bugs. No step locks in either result.
- The web app (`apps/web`) runs the same shared parser. Unit tests cover it in
  `apps/web/src/context/TimerContext.test.jsx`, and `e2e/web.agenda-flow.spec.js` runs this
  import (IM-01, IM-02) in a plain browser.
