---
id: agenda-import
title: Simple Format import takes exact role names and asks for the rest in the Zoom client
status: stale
covers:
  - packages/shared/simpleFormatParser.js
  - apps/zoom-app/src/context/TimerContext.jsx
  - apps/zoom-app/src/components/AgendaTab.jsx
automated:
  - packages/shared/__tests__/simpleFormatParser.test.js
  - apps/zoom-app/src/context/TimerContext.test.jsx
  - apps/zoom-app/src/components/AgendaTab.test.jsx
  - e2e/zoom.timer-flow.spec.js
needs:
  - dev deployed
  - camera on, in a meeting
  - club presets not live on this device (not in a club, or "Use mine" in Edit Rules)
  - no custom roles on the device before IM-01 (note and remove any in the run log)
  - built-in roles not hidden on this device (Standard Speech, Ice Breaker and Table Topics Speech in the role dropdown); a hidden one is highlighted as "not one of your roles" in IM-02, IM-05 and IM-06
verified_at: 0ba1f1c
verified_on: 2026-11-11 (Zoom 7.2.5, macOS 26.7.2, dev c80dca2b)
---

# Simple Format import takes exact role names and asks for the rest in the Zoom client

Added for #77 (PR #93), rewritten for #91. Agenda → Import Text → Simple Format reads the role
from the last `(...)` group. It takes the role only when the text names one of the roles in the
role dropdown (same words; case, spacing and punctuation ignored). Every other row is
highlighted on the Agenda tab with a "Pick a role" list, and is not timed until a role is
picked. The parser is unit-tested. This spec proves the deployed Zoom build does the same with
text pasted into the real webview, and that an imported or picked role drives the video with
its own thresholds. The Live tab's own ways onto the agenda (its suggestions, the Full-Screen
Timer's speaker list, the auto-advance after FINISH) refuse a highlighted row too; that is
[timer-core](timer-core.md) TC-13.

## Purpose
Catches an import that guesses: a row that silently lands on a near-miss custom role, a keyword
role, a hidden built-in or Standard Speech (5/6/7 min). The club then sees the card change at
the wrong time on real video. It also catches a paste that does not reach the Zoom webview's
textarea, and a highlighted row that still opens in the Live tab.

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
Expect: toast "Imported 6 speaker(s). 3 need a role". A red banner above the list reads "3 rows
need a role". The agenda shows these rows in this order (the "#77–#90" column is the guess the
app used to make, so a row showing that role is the bug):

| Row name | Role line | Highlighted | Why | #77–#90 |
|---|---|---|---|---|
| Cam-Ly - Opening | (Opening) | no | exact match | Opening |
| Dominique - General Evaluation | (Closing) is not one of your roles | yes | `Closing` is not a role | Closing Remarks |
| Yu | (Closing Remarks - 2 min) is not one of your roles | yes | extra words | Closing Remarks |
| Sam - Introduce Speakers | (Hand over) | no | case ignored | Hand over |
| Bob | (Ice Breaker) | no | built-in, listed | Ice Breaker |
| Lee | (Moment of Reflection) is not one of your roles | yes | no keyword guessing | Short Roles |

Each highlighted row is red, has a red bar on the left, and has a "Pick a role…" list under the
role line.
Evidence: page script: `toastmaster_agenda` has six items with those `name` values; the three
matched items have `role` Opening / Hand over / Ice Breaker and `rules` equal to that role's
entry in `toastmaster_role_rules`; the three others have `role` `Closing`,
`Closing Remarks - 2 min`, `Moment of Reflection` and no `rules`. In PostHog, the
`agenda_imported` event from this device has `import_type: "bulk"`, `items_count: 6`,
`custom_role_count: 2` and `needs_role_count: 3`. If the webview inspector is off, the
on-screen rows and PostHog stand in for the page script.

### IM-03 · auto · An imported custom role drives the video colours
Do: Agenda tab → in the "Dominique - General Evaluation" and "Yu" rows pick "Closing Remarks"
and in the "Lee" row pick "Short Roles" from the "Pick a role…" list (the banner goes once all
three are picked; IM-06 checks the pick itself). Then click the "Cam-Ly - Opening" row (it
opens the Live tab with that speaker).
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

### IM-05 · auto · A built-in role in the brackets beats a keyword in the name
Do: first run IM-04 (clean device). Agenda tab → Import Text → "Simple Format". Put these two
lines on the clipboard with `pbcopy`, click the textarea, paste with ⌘V, press Import.
```
Tim Timer (Standard Speech)
Dominique - General Evaluation (Table Topics)
```
Expect: toast "Imported 2 speaker(s). 1 needs a role". Row "Tim Timer" shows (Standard Speech),
not Short Roles from "Timer" in the name. Row "Dominique - General Evaluation" is highlighted
with "(Table Topics) is not one of your roles", not General Evaluation from the name. Click
"Tim Timer": the Live tab role dropdown shows Standard Speech and the timing rules read
Green: 5 minutes, Yellow: 6 minutes, Red: 7 minutes (not Short Roles' 1 / 1:30 / 2).
Evidence: page script: `toastmaster_agenda` items are `Tim Timer` / `Standard Speech` and
`Dominique - General Evaluation` / `Table Topics` with no `rules`. Screenshot of the
highlighted row and of the Live tab rules line.
Then Clear All in the Agenda tab.
Run 2026-11-11 (0ba1f1c, before #91): the import half passed on the real client with the old
expectation (Dominique → Table Topics). The Live-tab half could not be checked: that device hid
the built-in roles. See the `needs` line.

### IM-06 · auto · A row that needs a role is picked by hand, then times with that role (#91)
Do: first run IM-04 (clean device). Agenda tab → Import Text → "Simple Format". Put these
three lines on the clipboard with `pbcopy`, click the textarea, paste with ⌘V, press Import.
```
David Kim (Table Topics Speech)
Alex (Table Topics)
Bob
```
Then: click the "Alex" row. Then pick "Table Topics Speech" in Alex's "Pick a role…" list and
"Short Roles" in Bob's. Then click "David Kim", press Start with the camera on, and run
`capture-timeline.sh` with shots at about `50:blue 65:green 95:yellow`. Finish the speech.
Expect:
- After Import: toast "Imported 3 speaker(s). 2 need a role"; banner "2 rows need a role".
  "David Kim" shows (Table Topics Speech), not highlighted. "Alex" is highlighted with
  "(Table Topics) is not one of your roles"; "Bob" with "No role given".
- Clicking "Alex": the Agenda tab stays open and a toast reads "Pick a role for Alex first".
- After the two picks: no row is highlighted and the banner is gone. "Alex" shows
  (Table Topics Speech) and "Bob" (Short Roles).
- "David Kim" in the Live tab: role dropdown Table Topics Speech, rules line "Green: 1 minute,
  Yellow: 1 min 30 sec, Red: 2 minutes". START runs with no "Please set timing rules first"
  toast. No colour before 1:00, green from 1:00, yellow from 1:30.
Evidence: screenshots of the highlighted rows, the toast after clicking Alex, and the cleared
list; timeline shots with timestamps. Page script (or on-screen rows if the inspector is off):
`toastmaster_agenda` has Alex as `Table Topics Speech` with `rules` 60/90/120 and Bob as
`Short Roles` with 30/45/60. PostHog from this device: `agenda_imported` with
`items_count: 3`, `needs_role_count: 2`, and two `agenda_role_picked` events with
`is_custom: false`.
Then Clear All in the Agenda tab.

## Not covered
- Custom roles that come from Club Pro presets, or from older saved rules with no role
  order. The PR now covers these too (`customRoleNames` comes from the dropdown, not from
  `customRoleOrder`). Unit test: `TimerContext.test.jsx` "imports a custom role whose rules
  were saved without a role order". A real-client step belongs in `pro-club` once that spec
  is migrated.
- What counts as the same name (case, spacing, punctuation, word order), a hidden built-in or
  deleted custom role in brackets, rows saved before #91 as `Table Topics`, and the Edit
  modal's "Pick a role…" start. Unit tests in `simpleFormatParser.test.js`,
  `TimerContext.test.jsx` and `AgendaTab.test.jsx` cover these; the client adds nothing.
- EasySpeak import. Its role mapping did not change; a row whose mapped role is hidden is
  highlighted like any other. No spec yet.
- The web app (`apps/web`) runs the same shared parser. Unit tests cover it in
  `apps/web/src/context/TimerContext.test.jsx`, and `e2e/web.agenda-flow.spec.js` runs this
  import (IM-01, IM-02) in a plain browser.
