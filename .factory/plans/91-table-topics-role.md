# Simple Format import: ask for a role when the bracket doesn't name one, instead of guessing (#91)

## Problem
Agenda → Import Text → Simple Format guesses a role whenever the bracket does not name one of
your roles exactly. The guess is often wrong and the app says nothing:
- `(Table Topics Speech)` and `(Table Topics)` land on `Table Topics`, which is not a rules
  key. The row gets Standard Speech's 5/6/7 min, and START shows "Please set timing rules
  first" (the original report).
- A bracket close to a custom role takes that role: `(Table Topics)` becomes a custom
  `Table Topics Master`, `(Speaker)` becomes `Keynote Speaker`.
- A built-in role you hid in Edit Rules still imports, with Standard Speech timing.

Direction (2026-11-13, replaces the first plan that fixed the keyword ladder): import does
not guess. A bracket that names one of your roles gets it. Every other row is highlighted on
the Agenda tab and you pick its role from your saved roles.

## Findings
- Verified on `dev` a4439d6 with the shared parser, custom roles `Keynote Speaker` and
  `Table Topics Master`, `Ice Breaker` hidden (rules = what `importBulkSpeakers` stores):

  | Line | Role | Rules (s) | How |
  |---|---|---|---|
  | `A (Standard Speech)` | Standard Speech | 300/360/420 | exact |
  | `B (keynote speaker)` | Keynote Speaker | 600/720/840 | exact, case ignored |
  | `C (Keynote)` | Keynote Speaker | 600/720/840 | closest custom role |
  | `D (Speaker)` | Keynote Speaker | 600/720/840 | closest custom role |
  | `E (Table Topics Speech)` | Table Topics | 300/360/420 | keyword, not a key |
  | `F (Table Topics)` | Table Topics Master | 10/20/30 | closest custom role |
  | `G (Toastmaster of the Evening)` | Short Roles | 30/45/60 | keyword |
  | `H (Educational Talk)` | Standard Speech | 300/360/420 | default |
  | `I (Ice Breaker)` | Ice Breaker | 300/360/420 | hidden role |
  | `J` (no bracket) | Standard Speech | 300/360/420 | default |
  | `Coffee break` | Take a Break | 300/360/420 | keyword, Standard Speech rules |

- Order today in `parseSimpleFormatText` (`packages/shared/simpleFormatParser.js:80-98`):
  exact custom role → closest custom role (`matchCustomRole`, #77) → keywords in the
  bracket (`detectRoleFromText(bracket, names, null)`, #90) → keywords in the whole line →
  `'Standard Speech'`. Built-in names are never checked against the user's list, so hidden
  built-ins still match.
- `importBulkSpeakers` (web `TimerContext.jsx:243-258`, Zoom `:475-490`) stores
  `rules: roleRules[role] || DEFAULT_ROLE_RULES['Standard Speech']`.
- Users can remove roles: `removeRoleRules` hides a built-in (`toastmaster_hidden_builtin_roles`)
  or deletes a custom role. `roleOptions` is the list the role dropdowns show (visible
  built-ins, then custom roles; the Zoom app also lists `Take a Break`).
- `parseSimpleFormatText` is the only caller of `detectRoleFromText` and `matchCustomRole`.
  EasySpeak import has its own mapping (`easySpeakParser.js`).
- `toastmaster_agenda` is in `SYNCED_KEYS`, so rows reach other devices and older builds.
  Older builds treat an unknown `role` string like today's `Table Topics` row.
- The Live tab (both apps, e876ca8) moves a loaded speaker whose role is not in
  `roleOptions` to Standard Speech or the first listed role, with no notice. That covers the
  Live tab's agenda picker and the auto-advance after FINISH.

## Approach
Shared (`packages/shared/simpleFormatParser.js`):
- `findRoleByName(text, roleNames)`: the role in `roleNames` with the same words in the same
  order as `text` (case, spacing and punctuation ignored), or `null`.
- `parseSimpleFormatText(text, roleNames)` returns `{ name, role, roleText }`. `roleText` is
  the last `(...)` group as written; for a line with no bracket it is the whole line when that
  names a role, else `''`. `role` is `findRoleByName(roleText, roleNames)`, else `null`. The
  name rule is unchanged.
- `agendaItemNeedsRole(item, roleNames)`: true for a row that is not completed, is not a
  break, and whose role is not in `roleNames`. Derived on every render, so rows saved before
  this change (`Table Topics`) and rows whose role was later removed are flagged too.
- Remove `matchCustomRole` and `detectRoleFromText` (no callers left).

Apps (web and Zoom, same change):
- `importBulkSpeakers` matches against `roleOptions`. A matched row stores the role's exact
  name and its rules. An unmatched row stores `role: roleText` and no `rules`. Returns
  `{ count, needsRole }`. `agenda_imported` gains `needs_role_count`.
- Agenda tab, for a row that needs a role: red row with the text as written
  ("(Table Topics) is not one of your roles", or "No role given") and a "Pick a role" select
  of `roleOptions`. Picking calls `updateAgendaItem`, which stores that role's rules. A
  banner above the list counts these rows. Clicking such a row does not open the Live tab: a
  toast asks for a role first. Its Edit modal starts on "Pick a role…" with Update disabled.
- Import toast: "Imported N speaker(s)" when every row matched (unchanged); otherwise
  "Imported N speaker(s). M need a role" as a warning.
- Add Item defaults to Standard Speech, or the first listed role when Standard Speech is
  hidden (today it shows the first role but saves Standard Speech, which would now be flagged).

Not changed: EasySpeak's mapping (its rows are flagged only when the mapped role is not in
your list), the Live tab, the TimerContext load/update paths.

## Acceptance criteria
- AC-1: A bracket with the same words as one of your roles imports with that role's exact
  name and rules: `B (keynote speaker)` → `Keynote Speaker`; `David Kim (Table Topics
  Speech)` → `Table Topics Speech` with 60/90/120 s.
- AC-2: A bracket that is not exactly one of your roles imports with no role and no rules,
  keeping the text as written: `Alex (Table Topics)`, `C (Keynote)`, `D (Speaker)`,
  `Lee (Moment of Reflection)`, `Yu (Closing Remarks - 2 min)`. A line with no bracket that
  doesn't name a role imports with role `''`.
- AC-3: A bracket naming a hidden built-in or a removed custom role is not matched.
- AC-4: The Agenda tab highlights every row that needs a role, shows its text as written, and
  offers a "Pick a role" select of your roles. A banner counts these rows. Completed rows and
  breaks are never highlighted.
- AC-5: Picking a role sets the row's role and that role's rules, and the highlight goes.
- AC-6: Clicking a highlighted row keeps the Agenda tab open and shows "Pick a role for
  {name} first". Its Edit modal starts on "Pick a role…" and Update is disabled until a role
  is picked.
- AC-7: Import toast and analytics as in Approach.
- AC-8: A row saved earlier with a role that is not in your list (e.g. `Table Topics`) is
  highlighted when the Agenda tab opens.
- AC-9: #90 still holds: a keyword in the name never sets the role.
  `Dominique - General Evaluation (Table Topics)` needs a role; it is not General Evaluation.
- AC-10: Add Item's role starts on Standard Speech, or on the first listed role when Standard
  Speech is hidden.

## Test list
| AC | Unit | Playwright | Zoom-client (`agenda-import`) |
|---|---|---|---|
| AC-1 | `simpleFormatParser.test.js` | `zoom.timer-flow`, `web.agenda-flow` | IM-02, IM-06 |
| AC-2 | `simpleFormatParser.test.js`, both `TimerContext.test.jsx` | same | IM-02, IM-06 |
| AC-3 | `simpleFormatParser.test.js`, Zoom `TimerContext.test.jsx` | — | — |
| AC-4 | both `AgendaTab.test.jsx` | `zoom.timer-flow`, `web.agenda-flow` | IM-02, IM-06 |
| AC-5 | both `AgendaTab.test.jsx` | same | IM-06 |
| AC-6 | both `AgendaTab.test.jsx` | — | IM-06 |
| AC-7 | both `TimerContext.test.jsx`, `AgendaTab.test.jsx` | toast text | IM-02 (PostHog) |
| AC-8 | both `AgendaTab.test.jsx` | — | — |
| AC-9 | `simpleFormatParser.test.js` | `zoom.timer-flow` (#90 test) | IM-05 |
| AC-10 | both `AgendaTab.test.jsx` | — | — |

## Risk
Medium-low. Client-side parsing and the Agenda tab in both apps. No API, Worker, sync format
or migration. Visible change: lines that used to get a guessed role now need a pick, so an
agenda pasted with loose role names needs a few clicks. Rows synced to an older build keep
their text as role and no rules; that build times them as Standard Speech, as it does today
for `Table Topics`.

## Decisions (2026-11-13)
- Exact means same words, same order; case, spacing and punctuation don't count.
- A line with no bracket gets a role only when the whole line names one; otherwise it needs a
  role. No keyword guessing anywhere in Simple Format import.
- The first plan's questions are moot: there is no `Table Topics Master` → `Short Roles`
  mapping (Q1), old `Table Topics` rows are flagged by AC-8 (Q2), `timingRules.js` only
  loses dead code (Q3), and the Zoom placeholder `Alex (Table Topics)` is replaced by a line
  with built-in names (Q4).

## Follow-up (not in this PR)
- The Live tab can still load a highlighted row through its agenda picker or the auto-advance
  after FINISH, and then times it with the default role (e876ca8). Refusing those loads
  touches `LiveTab.jsx` in both apps, which three more Zoom specs cover.
