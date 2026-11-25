# Zoom timer: on-the-spot speakers — insert position, explicit edit-vs-add, role write-back (#168)

## Problem
Table Topics speakers are picked on the spot. In the Zoom app a new speaker lands at the end of
the agenda, Enter on the name field renames or adds depending on state the user cannot see, and a
role change updates the timer but not the agenda row. The issue's three decisions (Nov 21) fix
the rules; this plan carries them out.

**Both looks (instruction from the owner, Nov 25).** Every acceptance criterion below holds in the
**old look** (Live tab panel and the full-screen stage) and in the **new look** (design B, behind
`new_look`). Neither look gets the change alone, and one shared state and one shared options
component keep them from drifting apart.

## Findings
The logic is already shared; the pickers are not.

- **Shared logic**: `apps/zoom-app/src/hooks/useLiveTimer.js` — `handleAddSpeaker` (~517),
  `handleRenameSpeaker` (~539), `handleRoleChange` (544). Both looks call these.
  `handleAddSpeaker` passes `role: selectedRole` and `{ activate: true }`.
- **Append only**: `addToAgenda` in `apps/zoom-app/src/context/TimerContext.jsx:410` does
  `setAgenda(prev => [...prev, newItem])`; the web copy is `apps/web/src/context/TimerContext.jsx:201`.
  Its other callers (Agenda tab form via `useAgendaEditor.js:115`, bulk imports) build the running
  order and must keep appending.
- **Role never reaches the row**: `handleRoleChange` ends in `setCurrentSpeaker(...)` only.
  `updateAgendaItem` (TimerContext:444) already writes name, role and rules to a row and the
  current speaker; nothing in the Live tab calls it. Break detaches the row on purpose
  (`clearActiveSpeaker`, useLiveTimer:~556) and stays that way.
- **Old look, Enter is implicit** — `components/SpeakerInput.jsx:82-93` (`pendingRename` when a
  row is loaded, `pendingAdd` when none is; hint text at :245-252) and, on the stage,
  `components/StageSpeakerPicker.jsx:57-58, 82-87, 136-139` (same rule). `TimerStage.jsx:242`
  mounts the stage picker for **both** looks.
- **New look, Enter always adds** — `b/SpeakerPicker.jsx:79-80, 105-111`: Enter picks an exact match
  or adds; Rename exists only as a list row below the Add row. So the two looks already disagree on
  what Enter does with a row loaded.
- **Likely reason the 1–2 min timer never shows** (inferred from the code, not reproduced): the new
  slot takes `selectedRole`, which with the block row loaded is the block's own role, so the
  display stays on the 5–10 min block thresholds.
- **Settings**: persisted booleans live in `packages/shared/storage.js` (e.g.
  `REVEAL_FACE_WHEN_IDLE`, :27, :255-277) and sync across a person's devices via
  `packages/shared/profileMerge.js` `SYNCED_KEYS`.
- **Web** (`apps/web/src/components/LiveTab.jsx:140-190`): typing a name only labels the timer; no
  agenda writes. Not part of "both looks".
- **Specs**: `e2e/zoom-client/timer-core.md` covers `LiveTab.jsx`, `useLiveTimer.js`,
  `TimerContext.jsx` but not `SpeakerInput.jsx` or `StageSpeakerPicker.jsx`; `new-look.md` covers
  `apps/zoom-app/src/b` and `TimerStage.jsx`. Last IDs: TC-13, NL-20.
- **Overlap**: draft PR #143 (#80) edits `LiveTab.jsx`, `TimerStage.jsx`, `App.jsx`; it is already
  conflicting with `dev` (74 commits behind). #169 does not touch these files.

## Approach
Smallest change that meets the criteria:

1. **Pure helper + two settings in `packages/shared`.** `agendaInsert.js`:
   `insertAfter(agenda, afterId, item)` (append when `afterId` is null or not found). Two settings
   in `storage.js` with load/save: `speakerInsertPosition` (`'afterActive'` default | `'end'`) and
   `speakerEnterAction` (`'edit'` default | `'add'`). Both keys join `SYNCED_KEYS`.
2. **`addToAgenda(speaker, { activate, insertAfter })`** in the Zoom `TimerContext`: `insertAfter`
   is an agenda id; absent means append, so the Agenda tab and imports are unchanged. The web
   context is left alone.
3. **One edit/add model in `useLiveTimer`**, exposed to both looks:
   - `editingItem` = the loaded agenda row (if any).
   - `handleAddSpeaker(name, role?)` computes `insertAfter` from the setting and the loaded row.
   - `handleCommitName(name)` is what Enter calls: edit when a row is loaded and the Enter setting
     is `edit`, otherwise add. No row loaded means add, whatever the setting says.
   - `handleRoleChange(role)` while a row is loaded and being edited also calls `updateAgendaItem`
     (name, role, rules). Break still detaches. In add mode (below) it never touches the row.
   - A typed name that exactly matches an agenda row is still never added a second time, as today.
4. **Add mode.** An explicit "Add new speaker" action. With a name typed it adds at once, with the
   role shown. With the field empty it clears the name and keeps the role picker, so a role picked
   before the name goes to the new row and never to the loaded one. Once added the new row is
   loaded and the control is back in edit mode.
5. **UI, same wording in both looks**: the control shows "Editing <name> · <role>" when a row is
   loaded, an "Add new speaker" button, and a hint that names what Enter does ("Enter updates
   Jon" / "Enter adds Dana after Jon as Table Topics Speaker").
   - Old look: `SpeakerInput.jsx` (panel) and `StageSpeakerPicker.jsx` (stage).
   - New look: `b/SpeakerPicker.jsx`; its two rows become "Update <row>" (first, the default) and
     "Add <name> as <role>", and Enter follows the setting.
6. **One `SpeakerEntryOptions` component** (the two settings), used by both looks so they cannot
   diverge: collapsed "Speaker options" under the name field in the old look; the last section of
   the speaker popover in the new look. The stage reads the settings and shows none.
7. **Zoom-client specs.** Add TC-14 (old look) to `timer-core.md` and NL-21 (new look) to
   `new-look.md`; add `SpeakerInput.jsx` and `StageSpeakerPicker.jsx` to `timer-core.md` `covers`.
   Run TC-14 with FLAGS_FORCE `"1,new_look=0"` and NL-21 with `"1,pro=0"`.

Rejected: a new "section mode" (the issue puts it out of scope); making the Agenda tab form follow
the insert setting (it builds the running order, and the user places rows there); changing the web
Live tab (the issue allows a documented difference); a dedicated settings sheet in the new look
(more layout work for two toggles).

## Acceptance criteria
Each criterion holds in the **old look** (panel and stage) and the **new look**; the tests below
run the same steps through both.

- AC-1: Given the agenda [A, B, C] with B loaded and the insert setting at its default, when a new
  speaker D is added (typed name or a guest from "In this meeting"), then the agenda is
  [A, B, D, C], D is loaded, and the timer shows D's role rules.
- AC-2: Given the same agenda and the setting on "at the end", when D is added, then the agenda is
  [A, B, C, D] and D is loaded.
- AC-3: Given no row is loaded, when a speaker is added, then they go to the end, whichever
  setting is on.
- AC-4: Given either setting is changed in one look, when the user opens the other look or reloads,
  then the same value shows, and it is in the synced profile keys.
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
- AC-9: Given B is loaded and being edited, when the role is changed to "Table Topics Speaker",
  then B's agenda row takes that role and its rules, the timer shows those thresholds, and the Agenda
  tab shows the new role. Choosing Break still detaches B and leaves the row untouched.
- AC-10: Given the user is adding a speaker, when they pick a role before the name is committed,
  then the new row gets that role and B's row keeps its own. The add control names the role the new
  row will get.
- AC-11: Given the same sequence of actions in each look, then the agenda and the timer end up
  identical (a parity test over the shared hook, plus the real-client steps).
- AC-12: Given the web app, then typing a name on its Live tab still only labels the timer, and the
  difference from the Zoom app is stated in a comment on the web `addToAgenda` and in this plan.

## Test list
| AC | Unit | Playwright | Zoom-client spec |
|---|---|---|---|
| AC-1, 2, 3 | `packages/shared/__tests__/agendaInsert.test.js` (NEW); `apps/zoom-app/src/context/TimerContext.test.jsx` (`insertAfter`); `useLiveTimer.test.jsx` | `e2e/zoom.timer-flow.spec.js` (old look); `e2e/zoom.new-look.spec.js` | TC-14 (NEW, old look); NL-21 (NEW, new look) |
| AC-4 | `packages/shared/__tests__/storage.test.js`; `profileMerge.test.js` | `e2e/zoom.new-look.spec.js` (value shared by both looks) | NL-21 |
| AC-5, 7 | `SpeakerInput.test.jsx`, `StageSpeakerPicker.test.jsx`; `b/TimerCard.test.jsx`, `b/Phase3.test.jsx` | both Zoom specs above | TC-14, NL-21 |
| AC-6, 8 | same four component tests; `useLiveTimer.test.jsx` | both | TC-14, NL-21 |
| AC-9, 10 | `useLiveTimer.test.jsx`; `TimerContext.test.jsx` | both | TC-14, NL-21 |
| AC-11 | `useLiveTimer.test.jsx` (one sequence, both look wirings) | — | TC-14 and NL-21 end states compared in `run.md` |
| AC-12 | `apps/web/src/context/TimerContext.test.jsx` (append unchanged) | `e2e/web.timer-flow.spec.js` | — |

## Risk
**Low.** No `config.json` `riskHigh` path is touched (`packages/shared/storage.js` and
`profileMerge.js` are not on the list). Two things to watch:
- **Enter changes in the new look**: with a row loaded, Enter used to add and now edits (the issue's
  default). The visible hint and the "Add new speaker" action make this findable, and the setting
  restores the old behaviour.
- **Merge conflicts**: a new prop on `TimerStage.jsx` (to pass the add handler to the stage picker)
  overlaps draft PR #143. Whichever merges second rebases; #143 already conflicts with `dev`.

This is the third open factory PR while `wipLimit` is 2: started on the owner's explicit
instruction, Nov 25.

## Open questions
- **Q1. Where do the two settings live?** Default: the shared `SpeakerEntryOptions`, collapsed
  under the name field in the old look and as the last section of the speaker popover in the new
  look. Alternative: the new look's ⋯ menu.
- **Q2. Add while a speech is running.** Default: unchanged from today, so the new speaker takes
  over and the timer resets to them; the running speech is not recorded. The block total only comes
  with the Table Topics section mode, which is out of scope.
- **Q3. Which role does the new slot get?** Default: the role currently shown in the picker (as
  today), now named on the add control, so Table Topics runs pick "Table Topics Speaker" before
  adding.
- **Q4. Does the Agenda tab's own "Add speaker" form follow the insert setting?** Default: no; it
  keeps appending, and imports are untouched.
- **Q5. Do the two settings sync across the person's devices?** Default: yes, like the other
  Zoom-app settings (`SYNCED_KEYS`).
- **Q6. Web parity.** Default: no change on the web Live tab, a documented difference (AC-12).
  Say if the web should follow in a separate issue.
