# Zoom timer: on-the-spot speakers — insert position, explicit edit-vs-add, role write-back (#168)

## Problem
Table Topics speakers are picked on the spot. In the Zoom app a new speaker lands at the end of
the agenda, Enter on the name field renames or adds depending on state the user cannot see, and a
role change updates the timer but not the agenda row. The issue's three decisions (Nov 21) fix
the rules; this plan carries them out.

**Scope: every surface where a speaker is named.** Every acceptance criterion holds in the **old
look** (Live tab panel and the full-screen stage), the **new look** (design B, behind `new_look`)
and the **web app's Live tab** (instruction from the owner, Nov 25: both looks, and the web stays in
sync). The web has one look and no stage, so the stage criteria don't apply there. Shared logic
and one set of labels keep the three from drifting apart.

## Decisions (owner, Nov 25)
- **Q2: adding never interferes with a running timer.** A speaker added while a speech is in
  progress (running, or paused with time on the clock) goes into the agenda but is not loaded, and
  the timer, its label, the colour and the video overlay are untouched. They come up when the
  running speech is finished (FINISH already advances to the next row). *Consequence to confirm:*
  with the Table Topics block row running, a speaker added then waits behind it and the display
  does not switch to their 1–2 min timer until the block is finished or reset. Switching at once is
  what the Table Topics section mode would do, which the issue puts out of scope.
- **Q6: the web follows the Zoom app** (rules, two settings, wording), in this issue.
- **Q1, Q4, Q5: the defaults** below.
- **Q3: the default.** The new slot takes the role shown on the add control (confirmed on a
  mockup).
- **Old look: a visible Update button**, not only Enter. Editing the current speaker and adding
  another are both a click away, and Enter does the same as the button.

## Findings
The logic is already shared in the Zoom app; the pickers are not.

- **Shared logic (Zoom)**: `apps/zoom-app/src/hooks/useLiveTimer.js` — `handleAddSpeaker` (~517),
  `handleRenameSpeaker` (~538), `handleRoleChange` (544). Both looks call these.
  `handleAddSpeaker` passes `role: selectedRole` and `{ activate: true }`; `activate` resets the
  timer, which is what Q2 rules out while a speech is in progress.
- **Append only**: `addToAgenda` in `apps/zoom-app/src/context/TimerContext.jsx:410` does
  `setAgenda(prev => [...prev, newItem])`; the web copy is `apps/web/src/context/TimerContext.jsx:201`.
  Its other callers (Agenda tab form via `useAgendaEditor.js:115`, bulk imports) build the running
  order and must keep appending.
- **Role never reaches the row**: `handleRoleChange` ends in `setCurrentSpeaker(...)` only.
  `updateAgendaItem` (TimerContext:444, web :219) already writes name, role and rules to a row and
  the current speaker; nothing in the Live tab calls it. Break detaches the row on purpose
  (`clearActiveSpeaker`, useLiveTimer:~555) and stays that way.
- **Old look, Enter is implicit** — `components/SpeakerInput.jsx:82-93` (`pendingRename` when a
  row is loaded, `pendingAdd` when none is; hint text at :245-252) and, on the stage,
  `components/StageSpeakerPicker.jsx:57-58, 82-87, 136-139` (same rule). `TimerStage.jsx:242`
  mounts the stage picker for **both** looks.
- **New look, Enter always adds** — `b/SpeakerPicker.jsx:79-80, 105-111`: Enter picks an exact match
  or adds; Rename exists only as a list row below the Add row. So the two looks already disagree on
  what Enter does with a row loaded.
- **Typing relabels the timer**: in the old look, typing in the name field updates the current
  speaker's label at once (`handleSpeakerChange` → `updateSpeakerName`). An add flow that reused
  that field would relabel a speaker who is on the clock, so add mode needs its own draft text.
- **Web** (`apps/web/src/components/LiveTab.jsx:140-190`, `SpeakerInput.jsx`): typing only labels
  the timer; picking a suggestion copies name and role and does **not** load the agenda row, so the
  Live tab has no "loaded row" at all (only the Agenda tab's load button sets `activeSpeakerId`);
  the web context has no `renameAgendaSpeaker`. The web also syncs settings through
  `profileSync` / `SYNCED_KEYS`, so one new key reaches both apps.
- **Likely reason the 1–2 min timer never shows** (inferred from the code, not reproduced): the new
  slot takes `selectedRole`, which with the block row loaded is the block's own role, so the
  display stays on the 5–10 min block thresholds.
- **Settings**: persisted booleans live in `packages/shared/storage.js` (e.g.
  `REVEAL_FACE_WHEN_IDLE`, :27, :255-277) and sync via `packages/shared/profileMerge.js`
  `SYNCED_KEYS`. `packages/shared` holds no React, so each app builds its own options UI.
- **Specs**: `e2e/zoom-client/timer-core.md` covers `LiveTab.jsx` (Zoom and web), `useLiveTimer.js`,
  `TimerContext.jsx` but not `SpeakerInput.jsx` or `StageSpeakerPicker.jsx`; `new-look.md` covers
  `apps/zoom-app/src/b` and `TimerStage.jsx`. Last IDs: TC-13, NL-20.
- **Overlap**: draft PR #143 (#80) edits `LiveTab.jsx`, `TimerStage.jsx`, `App.jsx`; it is already
  conflicting with `dev` (74 commits behind). #169 does not touch these files.

## Approach
Smallest change that meets the criteria:

1. **Pure logic + two settings in `packages/shared`.** `speakerEntry.js`:
   `insertAfter(agenda, afterId, item)` (append when `afterId` is null or not found);
   `resolveEnter({ loadedRow, typed, enterSetting })` → `'edit' | 'add' | 'none'`;
   `addPlan({ speechActive, insertPosition, loadedRowId })` → `{ insertAfter, activate }`
   (`activate` is false while a speech is in progress). Two settings in `storage.js` with
   load/save: `speakerInsertPosition` (`'afterActive'` default | `'end'`) and `speakerEnterAction`
   (`'edit'` default | `'add'`). Both keys join `SYNCED_KEYS`.
2. **`addToAgenda(speaker, { activate, insertAfter })`** in both contexts: `insertAfter` is an
   agenda id; absent means append, so the Agenda tab and imports are unchanged. The web context also
   gains `renameAgendaSpeaker`, mirroring the Zoom one.
3. **One edit/add model per app, built from those functions.** Zoom: in `useLiveTimer` (both looks).
   Web: in `LiveTab.jsx`.
   - `editingItem` = the loaded agenda row, if any. On the web, picking a suggestion now loads the row
     through `loadSpeakerFromAgenda`, as the Zoom app does.
   - `handleAddSpeaker(name, role?)` asks `addPlan` where to insert and whether to load. While a
     speech is in progress it only inserts and says so in a toast; it never resets the timer or
     touches the label.
   - `handleCommitName(name)` is what Enter calls, through `resolveEnter`. No row loaded means add,
     whatever the setting says.
   - `handleRoleChange(role)` while a row is loaded and being edited also calls `updateAgendaItem`
     (name, role, rules). Break still detaches (Zoom). In add mode it never touches the row.
   - A typed name that exactly matches an agenda row is still never added a second time.
4. **Add mode.** An explicit "Add new speaker" action. With a name typed it adds at once, with the
   role shown. With the field empty it opens a draft field that holds the new name **apart from the
   timer's label**, and keeps the role picker, so a role picked before the name goes to the new row
   and never to the loaded one. Once added, the control returns to edit mode (on the new row when it
   was loaded, on the running one otherwise).
5. **UI, same wording on all three surfaces**: the control shows "Editing <name> · <role>" when a row
   is loaded, an "Add new speaker" button, and a hint that names what Enter does ("Enter updates
   Jon" / "Enter adds Dana after Jon as Table Topics Speech").
   - Old look: `SpeakerInput.jsx` (panel) and `StageSpeakerPicker.jsx` (stage), each with a
     visible Update button beside the add action; Enter does what that button does.
   - New look: `b/SpeakerPicker.jsx`; its two rows become "Update <row>" (first, the default) and
     "Add <name> as <role>", and Enter follows the setting.
   - Web: `SpeakerInput.jsx` and `LiveTab.jsx`, same labels.
6. **Settings UI.** Zoom: one `SpeakerEntryOptions` component used by both looks, collapsed
   "Speaker options" under the old look's name field and the last section of the new look's speaker
   popover (the stage reads the settings, shows none). Web: the same two options under its name
   field. The wording of both options is one shared string table in `speakerEntry.js`.
7. **Specs.** Add TC-14 (old look) to `timer-core.md` and NL-21 (new look) to `new-look.md`; add
   `SpeakerInput.jsx` and `StageSpeakerPicker.jsx` to `timer-core.md` `covers`. Run TC-14 with
   FLAGS_FORCE `"1,new_look=0"` and NL-21 with `"1,pro=0"`. The web is covered by Playwright
   (`e2e/web.*`), since the Zoom client does not host it.

Rejected: a "section mode" (the issue puts it out of scope); making the Agenda tab form follow the
insert setting (it builds the running order, and the user places rows there); a dedicated settings
sheet in the new look (more layout work for two toggles); a shared React component for the options
(`packages/shared` has none).

## Acceptance criteria
Each criterion holds in the **old look** (panel and stage), the **new look** and the **web Live
tab** (no stage there); the tests below run the same steps through each.

- AC-1: Given the agenda [A, B, C] with B loaded, no speech in progress and the insert setting at its
  default, when a new speaker D is added (typed name or a guest from "In this meeting"), then the
  agenda is [A, B, D, C], D is loaded, and the timer shows D's role rules.
- AC-2: Given the same agenda and the setting on "at the end", when D is added, then the agenda is
  [A, B, C, D] and D is loaded.
- AC-3: Given no row is loaded, when a speaker is added, then they go to the end, whichever
  setting is on.
- AC-4: Given either setting is changed on one surface, when the user opens another surface or
  reloads, then the same value shows, and both keys are in the synced profile keys.
- AC-5: Given a row is loaded, then the speaker control shows which row is being edited (name and
  role) and offers "Add new speaker"; with no row loaded it shows neither the label nor the edit
  hint.
- AC-6: Given B is loaded, the Enter setting is `edit`, and the user types "Dana" and presses Enter,
  then B is renamed to Dana in the agenda and on the timer, no row is added, and B keeps its place.
- AC-7: Given B is loaded and a name is typed, when the user uses "Add new speaker" (or the Add row),
  then a new row is added per AC-1/AC-2, B is unchanged, and the Enter setting makes no difference.
- AC-8: Given the Enter setting is `add` and B is loaded, when the user types a name and presses
  Enter, then a new row is added per AC-1/AC-2 and B is unchanged. With no row loaded, Enter adds
  under either setting.
- AC-9: Given B is loaded and being edited, when the role is changed to "Table Topics Speech",
  then B's agenda row takes that role and its rules, the timer shows those thresholds, and the Agenda
  tab shows the new role. Choosing Break still detaches B and leaves the row untouched.
- AC-10: Given the user is adding a speaker, when they pick a role before the name is committed,
  then the new row gets that role and B's row keeps its own. The add control names the role the new
  row will get.
- AC-11: Given the same sequence of actions on each surface, then the agenda and the timer end up
  identical (a parity test over the shared functions and each surface's handlers, plus the
  real-client steps).
- AC-12: Given the web Live tab, then the same rules apply as in the Zoom app: Enter edits the
  loaded row, "Add new speaker" adds, the insert and Enter settings apply and sync with the Zoom
  app, and picking a suggestion loads its agenda row.
- AC-13: Given B is running (or paused with time on the clock) and the user adds D, then D is
  inserted per AC-1/AC-2 but not loaded, B's timer, label, colour and overlay are untouched, typing
  D's name never relabels B, and finishing B moves to D.

## Test list
| AC | Unit | Playwright | Zoom-client spec |
|---|---|---|---|
| AC-1, 2, 3 | `packages/shared/__tests__/speakerEntry.test.js` (NEW); both `TimerContext.test.jsx` (`insertAfter`); `useLiveTimer.test.jsx` | `e2e/zoom.timer-flow.spec.js` (old look); `e2e/zoom.new-look.spec.js`; `e2e/web.agenda-flow.spec.js` | TC-14 (NEW, old look); NL-21 (NEW, new look) |
| AC-4 | `packages/shared/__tests__/storage.test.js`; `profileMerge.test.js` | `e2e/zoom.new-look.spec.js` (value shared by both looks) | NL-21 |
| AC-5, 7 | zoom `SpeakerInput.test.jsx`, `StageSpeakerPicker.test.jsx`; `b/TimerCard.test.jsx`, `b/Phase3.test.jsx`; web `SpeakerInput.test.jsx`, `LiveTab.test.jsx` | the three above | TC-14, NL-21 |
| AC-6, 8 | same component tests; `useLiveTimer.test.jsx`; web `LiveTab.test.jsx` | the three above | TC-14, NL-21 |
| AC-9, 10 | `useLiveTimer.test.jsx`; both `TimerContext.test.jsx`; web `LiveTab.test.jsx` | the three above | TC-14, NL-21 |
| AC-11 | `useLiveTimer.test.jsx` and web `LiveTab.test.jsx` run one sequence through `speakerEntry` | — | TC-14 and NL-21 end states compared in `run.md` |
| AC-12 | web `SpeakerInput.test.jsx`, `LiveTab.test.jsx`, `TimerContext.test.jsx` | `e2e/web.timer-flow.spec.js`, `e2e/web.agenda-flow.spec.js` | — |
| AC-13 | `speakerEntry.test.js` (`addPlan`); `useLiveTimer.test.jsx`; web `LiveTab.test.jsx` | `e2e/zoom.timer-flow.spec.js`; `e2e/web.timer-flow.spec.js` | TC-14 (add while running, real video colour unchanged) |

## Risk
**Low.** No `config.json` `riskHigh` path is touched (`packages/shared/storage.js` and
`profileMerge.js` are not on the list). Size is **medium-large**: three surfaces, two apps. Watch:
- **Enter changes in the new look**: with a row loaded, Enter used to add and now edits (the issue's
  default). The visible hint and the "Add new speaker" action make this findable, and the setting
  restores the old behaviour.
- **Web picks load the row**: on the web, choosing a suggestion now loads its agenda row (as in
  Zoom), so FINISH ticks it off and advances; before, it only copied the name.
- **Synced keys**: two more keys in `SYNCED_KEYS`; `profileMerge.test.js` lists them.
- **Merge conflicts**: a new prop on `TimerStage.jsx` (to pass the add handler to the stage picker)
  overlaps draft PR #143. Whichever merges second rebases; #143 already conflicts with `dev`.

This is the third open factory PR while `wipLimit` is 2: started on the owner's explicit
instruction, Nov 25.

## Open questions
- **Q7. A leaner control (proposed Nov 25, mockup shown to the owner).** Instead of separate
  Update and Add buttons plus list rows, every surface gets the same three parts:
  - a two-way switch, "Edit current" / "Add new", that starts on Edit when a row is loaded (the
    Enter setting becomes "which side the switch starts on");
  - one button whose label says exactly what it will do ("Update Table Topics to Dana", "Add Dana
    as Table Topics Speech"), with Enter doing the same;
  - a tag saying where the speaker came from ("From agenda · 2 of 3", or "New speaker · goes right
    after Table Topics").
  In Add mode the role control is for the new speaker only; the new look shows it inside the
  popover, so the card's role chip always means the current speaker. Default if unanswered: the
  current plan (separate Update and Add actions), with the old look's visible Update button.

Answered Nov 25: Q1, Q4 and Q5 take their defaults (settings under "Speaker options" in the old
look and in the new look's speaker popover; the Agenda tab form keeps appending; both settings
sync); Q2, Q3 and Q6 as under Decisions.
