# Simple Format import: words in the speaker name override the role in parentheses (#90)

## Problem
In Agenda → Import Text → Simple Format, a role keyword in the speaker's name beats the
built-in role written in the brackets. `Tim Timer (Standard Speech)` imports as Short Roles,
so the timer shows 1/1:30/2 min cards instead of 5/6/7 for that speaker.

## Findings
- The custom-role half of the issue is already fixed: since #77 (724944f, f34bdff),
  `parseSimpleFormatText` matches the last bracket against custom roles first
  ([simpleFormatParser.js:92](../../packages/shared/simpleFormatParser.js)). The issue's
  `(Closing)` and `(Reflection)` lines import correctly when those custom roles exist.
- What is still broken: when the bracket names no custom role, the parser falls back to
  `detectRoleFromText(line, names)` on the **whole line**
  ([simpleFormatParser.js:93](../../packages/shared/simpleFormatParser.js)). The keyword
  ladder in `detectRoleFromText`
  ([timingRules.js:67-174](../../packages/shared/timingRules.js)) checks `includes()` in a
  fixed order, so a name keyword earlier in the ladder wins over the bracket's role:
  - `Tim Timer (Standard Speech)` → Short Roles (`timer`; exact `standard speech` only
    matches when it is the whole text).
  - `Dominique - General Evaluation (Table Topics)` → General Evaluation (GE is checked
    before Table Topics).
- Both apps call the same shared parser (`apps/zoom-app/src/context/TimerContext.jsx:476`,
  `apps/web/src/context/TimerContext.jsx:244`), so one fix covers both.
- Coverage: unit `packages/shared/__tests__/simpleFormatParser.test.js`; Playwright
  `e2e/zoom.timer-flow.spec.js` "Simple Format import assigns custom roles" and
  `e2e/web.agenda-flow.spec.js`; Zoom-client spec `agenda-import` (covers
  `simpleFormatParser.js`; its "Not covered" lists #90 as a known open bug).

## Approach
Detect the role from the bracket before the whole line:

```
role = matchCustomRole(bracket)                       // unchanged (#77)
    ?? detectRoleFromText(bracket, names, null)       // new: bracket keywords, no default
    ?? detectRoleFromText(line, names)                // unchanged fallback
```

`detectRoleFromText` gets an optional third parameter `fallback` (default
`'Standard Speech'`, today's behaviour for every existing caller). Passing `null` returns
`null` when no exact name or keyword matched, so a bracket with no role words (`(A)`,
`(Pathways L2)`) still falls back to today's whole-line detection.

Rejected:
- Detecting from the bracket only, never the line: changes lines whose bracket holds a
  duration or project and whose role is in the name. Wider blast radius than the issue.
- Stripping the name before detection: the name isn't reliably separable ("Tim Timer",
  "Dominique - General Evaluation").

## Acceptance criteria
- AC-1: Given no custom roles, when `Tim Timer (Standard Speech)` is imported, then the
  item is `{ name: 'Tim Timer', role: 'Standard Speech' }`.
- AC-2: Given no custom roles, when `Dominique - General Evaluation (Table Topics)` is
  imported, then its role is `Table Topics`: the bracket's role beats an earlier keyword in
  the name.
- AC-3: Given a bracket with no role words, when `Person (A)` (no custom roles) and
  `Tim Timer (Pathways L2)` are imported, then today's whole-line detection still applies:
  `Standard Speech` and `Short Roles`.
- AC-4: Given a custom role `Closing`, when `Tim Timer (Closing)` is imported, then its role
  is `Closing` (#77's custom-first order is unchanged).
- AC-5: In the real Zoom client, pasting `Tim Timer (Standard Speech)` in Simple Format shows
  that row with Standard Speech and its 5/6/7 min thresholds.

## Test list
| AC | Unit | Playwright | Zoom-client spec |
|---|---|---|---|
| AC-1 | `simpleFormatParser.test.js`, new describe "built-in role in brackets (#90)" | `e2e/zoom.timer-flow.spec.js`, new test "Simple Format import: the bracket's built-in role beats the name (#90)" | `agenda-import` IM-05 (NEW) |
| AC-2 | same describe | same test | — |
| AC-3 | same describe | — | — |
| AC-4 | same describe | — | — |
| AC-5 | — | — | `agenda-import` IM-05 (NEW) |

`timingRules.test.js` gets a unit test for the new `fallback` parameter during implement
(it is an implementation detail, so it is not an oracle test).

## Risk
Low. Shared import parsing only; no `riskHigh` path. EasySpeak import and every other
`detectRoleFromText` caller keep the default fallback, so their behaviour is unchanged.

## Open questions
- **Q1.** A bracket with no role words but a role keyword in the name
  (`Tim Timer (Pathways L2)`): keep today's whole-line detection (Short Roles)?
  **Default: yes**, keep it. The bracket says nothing about the role, and some agendas put
  the role in the name part.
- **Q2.** A bracket keyword that is less specific than the name
  (`Ice Breaker - Ana (Speaker 1)`): the bracket wins (`Speaker` → Standard Speech), as the
  issue's "each item gets the role in its parentheses" asks? **Default: yes**, the bracket
  wins.
