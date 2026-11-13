# Simple Format import: "(Table Topics Speech)" imports as 'Table Topics' with no timing rules (#91)

## Problem
In Agenda → Import Text → Simple Format, any line whose role says "Table Topics" imports with
role `Table Topics`. That is not a rules key, so the row gets Standard Speech's 5/6/7 min
rules, the Live tab dropdown has no matching option, and START shows "Please set timing rules
first". It affects the demo file's `(Table Topics Speech)` and the Zoom placeholder's
`(Table Topics)`.

## Findings
- Reproduced on `origin/dev` (a4439d6) with the shared parser and no custom roles:
  `David Kim (Table Topics Speech)`, `Alex (Table Topics)`, `Sam (Table Topics Master)`,
  `Jo (Table Topics Evaluator)` and the bare line `Table Topics` all return role
  `Table Topics`, and `'Table Topics' in DEFAULT_ROLE_RULES` is `false`.
- Cause: `detectRoleFromText` in
  [timingRules.js](../../packages/shared/timingRules.js) returns a role that is not a key:
  - `:82` exact `table topics` → `'Table Topics'`
  - `:113-114` any text containing `table topics` → `'Table Topics'`
  - `DEFAULT_ROLE_RULES` (`:3-12`) only has `'Table Topics Speech'` and `'Table Topics Evaluation'`.
- Same ladder, same bug: `table topics master` (`:155`, short roles) and
  `table topics evaluator` can't be reached because `:113` catches them first. `evaluation`
  is matched at `:90`, but `evaluator` isn't, and the evaluator branch at `:144` skips text
  that contains `table topics`.
- Since #90 (c3a0f78), `parseSimpleFormatText`
  ([simpleFormatParser.js:93-96](../../packages/shared/simpleFormatParser.js)) tries custom
  roles, then `detectRoleFromText(bracket, names, null)`, then the whole line. The bracket
  `Table Topics Speech` doesn't exactly match a built-in name in `detectRoleFromText`, so it
  reaches `:113`. `parseSimpleFormatText` is the only caller of `detectRoleFromText`.
  EasySpeak import uses its own mapping (`easySpeakParser.js`).
- Downstream, both apps do `rules: roleRules[role] || DEFAULT_ROLE_RULES['Standard Speech']`
  (`apps/web/src/context/TimerContext.jsx:244-249`, `apps/zoom-app/src/context/TimerContext.jsx:476-481`).
  `LiveTab.handleStart` re-reads `roleRules[selectedRole]` and rejects
  (`apps/web/src/components/LiveTab.jsx:205`, `apps/zoom-app/src/components/LiveTab.jsx:614-630`).
  With a valid key from the parser, these work unchanged.
- Tests that currently assert the bug:
  - `packages/shared/__tests__/timingRules.test.js:130` (`'Table Topics'` with null fallback)
    and `:209-215` (`table topics master` → `Table Topics`, with a comment explaining why).
  - `packages/shared/__tests__/simpleFormatParser.test.js:91-93`: the demo-file test expects
    `Table Topics`.
  - `packages/shared/__tests__/simpleFormatParser.test.js:127-130` (#90 AC-2) expects
    `Table Topics`.
  - `e2e/zoom.timer-flow.spec.js:186-202` (#90) expects `(Table Topics)`.
  - Zoom-client spec `e2e/zoom-client/agenda-import.md` IM-05 expects the row and
    `toastmaster_agenda` to show `Table Topics`. "Not covered" lists #91 as a known open bug.
  - The two #90 test files are listed in `.factory/oracles/90.json`. The oracle guard and
    `check-oracle.mjs` only lock oracles of the branch's own issue, so #91 may update them.
    The #90 point still holds: the bracket beats the name's `General Evaluation`. Only the
    role string it lands on changes.
- Spec coverage: `agenda-import` covers `simpleFormatParser.js`, but no spec covers
  `timingRules.js`. Without a `covers` entry, `stop-gate.mjs --hits` finds nothing for this
  diff and the Zoom station would skip the real-client run.

## Approach
Fix the ladder in `detectRoleFromText` so every "table topics" text maps to a real key.
- Exact match: `table topics` → `'Table Topics Speech'`; add `table topics speech` →
  `'Table Topics Speech'`.
- Partial matches, in this order, replacing `:112-115`:
  1. `table topics evaluator` → `'Table Topics Evaluation'` (`evaluation` is already at `:90`)
  2. `table topics master` → `'Short Roles'` (the role the dead branch at `:155` meant)
  3. `table topics` → `'Table Topics Speech'`
- Remove the dead `table topics master` entry at `:155`, and the now-redundant
  `!normalized.includes('table topics')` guard at `:144` if the tests allow.
- No change to `simpleFormatParser.js`, the TimerContexts or the LiveTabs.
- Update the tests that assert the old result (listed above) and the `agenda-import` spec:
  - IM-05 now expects `Table Topics Speech`.
  - New step IM-06 covers the `(Table Topics Speech)` / `(Table Topics)` lines and START.
  - Add `packages/shared/timingRules.js` to `covers`.
  - Remove the #91 line from "Not covered".

Rejected:
- Alias `'Table Topics'` → `'Table Topics Speech'` in `importBulkSpeakers` and `handleStart`
  in both apps. That fixes the symptom in four places and leaves the parser returning a
  non-key.
- Add a `'Table Topics'` key to `DEFAULT_ROLE_RULES`. That makes a duplicate role in the
  dropdown, Edit Rules, club presets and analytics.
- Migrate stored agenda rows already saved as `Table Topics`. See Q2.

## Acceptance criteria
- AC-1: Given no custom roles, when `David Kim (Table Topics Speech)` is imported with Simple
  Format, then the row is `David Kim` / `Table Topics Speech` with rules 60/90/120 s (grace 30).
- AC-2: Given no custom roles, when `Alex (Table Topics)`, or the bare line `Table Topics`, is
  imported, then the role is `Table Topics Speech`.
- AC-3: Given an imported `Table Topics Speech` row, when it is loaded into the Live tab and
  START is pressed, then the dropdown shows `Table Topics Speech`, the rules read 1 / 1:30 /
  2 min, the timer runs, and no "Please set timing rules first" toast appears. This holds in
  both the web and Zoom apps.
- AC-4 (proposed): Given no custom roles, when `Sam (Table Topics Master)` is imported, then
  the role is `Short Roles`.
- AC-5 (proposed): Given no custom roles, when `Jo (Table Topics Evaluator)` or
  `Jo (Table Topics Evaluation)` is imported, then the role is `Table Topics Evaluation`.
- AC-6: Given `Dominique - General Evaluation (Table Topics)`, when imported, then the role is
  `Table Topics Speech`, not `General Evaluation` (#90 still holds).
- AC-7: For every text, `detectRoleFromText` returns one of: a `DEFAULT_ROLE_RULES` key,
  `BREAK_ROLE`, a passed custom role name, or the fallback. It never returns `'Table Topics'`.
- AC-8: A custom role named exactly `Table Topics` still wins for `(Table Topics)`. Existing
  results for other built-in roles are unchanged: the current suites pass, apart from the
  assertions listed in Findings.

## Test list
| AC | Unit | Playwright | Zoom-client |
|---|---|---|---|
| AC-1 | `simpleFormatParser.test.js`: demo-file test expects `Table Topics Speech`. `apps/{web,zoom-app}/src/context/TimerContext.test.jsx`: `importBulkSpeakers('David Kim (Table Topics Speech)')` stores rules 60/90/120 | `e2e/zoom.timer-flow.spec.js`: NEW test, import both lines, rows show `(Table Topics Speech)` | `agenda-import` NEW IM-06 |
| AC-2 | `timingRules.test.js`: exact + partial `table topics`; `:130` → `Table Topics Speech`. `simpleFormatParser.test.js`: `Alex (Table Topics)` | same NEW test | IM-06 |
| AC-3 | `apps/{web,zoom-app}/src/components/LiveTab.test.jsx`: START with `currentSpeaker.role = 'Table Topics Speech'` from an imported row shows no warning. If an existing test already proves this, reference it instead | same NEW test: click the row, Live tab dropdown is `Table Topics Speech`, rules line reads 1 minute / 1 minute 30 seconds / 2 minutes, START starts | IM-06: rules line + START on real video, card reaches green at 1:00 |
| AC-4 | `timingRules.test.js:209-215` rewritten → `Short Roles`. `simpleFormatParser.test.js`: `Sam (Table Topics Master)` | — | — (unit only) |
| AC-5 | `timingRules.test.js` + `simpleFormatParser.test.js`: evaluator / evaluation | — | — (unit only) |
| AC-6 | `simpleFormatParser.test.js:127-130` (#90 AC-2) → `Table Topics Speech` | `e2e/zoom.timer-flow.spec.js:186-202` (#90) expects `(Table Topics Speech)` | IM-05 updated |
| AC-7 | `timingRules.test.js`: NEW table test over ~25 inputs (built-in names, the demo files' lines, EasySpeak role labels, breaks, junk), asserting each result is in `ROLE_OPTIONS ∪ {BREAK_ROLE}` | — | — |
| AC-8 | `simpleFormatParser.test.js`: `matchCustomRole`/parse with custom `Table Topics` → `Table Topics`. Existing suites unchanged | `e2e/web.agenda-flow.spec.js` unchanged and green | IM-01…IM-04 unchanged |

## Risk
Low. One pure function in `packages/shared/timingRules.js`, whose only caller is the Simple
Format parser. No `riskHigh` paths. No stored data, sync format or API changes.
Visible change: Simple Format lines that used to import as `Table Topics` (broken) now import
as `Table Topics Speech`, and `Table Topics Master` now imports as `Short Roles`. The change
edits tests that #90's oracle recorded (see Findings). That is intended and outside the guard's
scope, but a reviewer should know.

## Open questions
- Q1: Should `Table Topics Master` import as `Short Roles` (AC-4) and `Table Topics Evaluator`
  as `Table Topics Evaluation` (AC-5)? Neither is in the issue's expected result; both
  currently land on the broken `Table Topics`. **Default: yes, include both.** They are the
  same bug in the same three lines.
- Q2: Agenda rows already saved as `Table Topics` (localStorage or club sync) stay broken until
  they are re-imported or edited. Should load or START map `Table Topics` → `Table Topics Speech`?
  **Default: no.** Out of scope: it adds an alias in both apps for data that is easy to fix
  by re-importing. File a follow-up if PostHog `unknown_role` still shows `Table Topics`
  after release.
- Q3: Add `packages/shared/timingRules.js` to `agenda-import`'s `covers`? Then later edits
  to the timing rules (breaks, defaults) will also flag this spec for drift review.
  **Default: yes.** Otherwise no spec covers this diff and the Zoom station skips the
  real-client run.
- Q4: Keep the Zoom placeholder `Alex (Table Topics)` in `AgendaTab.jsx:454`? It works after
  this fix. **Default: keep it** (no UI change).
