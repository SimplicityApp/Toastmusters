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
  running speech is finished (FINISH already advances to the next row). *Consequence:* with the
  Table Topics block row running, a speaker added then waits behind it and the display does not
  switch to their 1–2 min timer until the block is finished or reset. Switching at once is what the
  Table Topics section mode would do, which the issue puts out of scope.
- **Q6: the web follows the Zoom app** (controls, rules, two settings, wording), in this issue.
- **Q1, Q4, Q5: the defaults** (settings under a collapsed "Speaker options"; the Agenda tab's own
  add form keeps appending; both settings sync across devices).
- **Q3:** the new speaker starts with the role on the clock, shown and changeable in the add panel.
- **The control (Q7 → Q8, settled on mockup version 5).** No mode switch: a switch reads as more
  tabs next to the Agenda / Timer / Report tabs. Instead:
  - **Status is a dot, never a button:** "On the agenda · 2 of 3" or "Not on the agenda", plus
    "Unsaved changes" while an edit is pending.
  - **Every button says what tapping it will do**, not what the state is: "Update Jordan on the
    agenda", "Add Dana after Jordan", "Switch to quick timing", "Save Dana to the agenda", "Back
    to agenda (next: Jordan, Table Topics)". No underlined text links.
  - **Edit in place covers name and role.** Both are staged; the Update button lists every change
    ("name Jordan → Dana · role → Table Topics Speech") and "Undo changes" sits under it. Nothing on
    the agenda or the clock changes until Update (or Enter). The old look gets this visible Update
    button, not only Enter.
  - **Adding is its own small panel** ("+ Add a speaker after Jordan"), with its own name and role
    and one button. It never touches the speaker on the clock.
  - **Quick timing needs no mode.** With no row loaded the field just labels the timer; with a row
    loaded, "Switch to quick timing" lets go of it and "Back to agenda (next: …)" returns.
  - **START never writes to the agenda.** FINISH records every timed speech in the Timer's Report
    and club history, agenda or not.

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
- **FINISH records any timed speech**: `finishCurrentSpeech` (TimerContext:559-586) adds the report
  and the club record whenever there is a current speaker with time on the clock, and ticks off a
  row only if one is loaded. Quick timing needs nothing new here.
- **Old look, Enter is implicit** — `components/SpeakerInput.jsx:82-93` (`pendingRename` when a
  row is loaded, `pendingAdd` when none is; hint text at :245-252) and, on the stage,
  `components/StageSpeakerPicker.jsx:57-58, 82-87, 136-139` (same rule). `TimerStage.jsx:242`
  mounts the stage picker for **both** looks.
- **New look, Enter always adds** — `b/SpeakerPicker.jsx:79-80, 105-111`: Enter picks an exact match
  or adds; Rename exists only as a list row below the Add row. So the two looks already disagree on
  what Enter does with a row loaded.
- **Typing relabels the timer**: in the old look, typing in the name field updates the current
  speaker's label at once (`handleSpeakerChange` → `updateSpeakerName`). With staged edits, a loaded
  speaker's label changes on Update instead; a quick timing still relabels as you type.
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
  `SYNCED_KEYS`. `packages/shared` holds no React, so each app builds its own UI.
- **Specs**: `e2e/zoom-client/timer-core.md` covers `LiveTab.jsx` (Zoom and web), `useLiveTimer.js`,
  `TimerContext.jsx` but not `SpeakerInput.jsx` or `StageSpeakerPicker.jsx`; `new-look.md` covers
  `apps/zoom-app/src/b` and `TimerStage.jsx`. Last IDs: TC-13, NL-20.
- **Overlap**: draft PR #143 (#80) edits `LiveTab.jsx`, `TimerStage.jsx`, `App.jsx`; it is already
  conflicting with `dev` (74 commits behind). #169 does not touch these files.

## Approach
Smallest change that meets the criteria:

1. **Pure logic, labels and two settings in `packages/shared/speakerEntry.js`.**
   - `insertAfter(agenda, afterId, item)`: append when `afterId` is null or not found.
   - `addPlan({ speechActive, insertPosition, anchorId })` → `{ insertAfter, activate }`, where the
     anchor is the loaded row, or the row let go of for a quick timing; `activate` is false while a
     speech is in progress.
   - `pendingChanges({ row, name, role })` → `{ name?, role? }` or null.
   - `actionLabels(state)` → the exact button and status strings, so all three surfaces say the
     same words ("Update Jordan on the agenda", "Back to agenda (next: Jordan, Table Topics)" …).
   - Settings in `storage.js` with load/save: `speakerInsertPosition` (`'afterActive'` default |
     `'end'`) and `speakerEnterAction` (`'update'` default | `'add'`). Both keys join `SYNCED_KEYS`.
2. **`addToAgenda(speaker, { activate, insertAfter })`** in both contexts: `insertAfter` is an
   agenda id; absent means append, so the Agenda tab and imports are unchanged. The web context also
   gains `renameAgendaSpeaker`, mirroring the Zoom one.
3. **One speaker model per app, built from those functions.** Zoom: in `useLiveTimer` (both looks).
   Web: in `LiveTab.jsx`.
   - `loadedRow` (from `activeSpeakerId`) and `releasedRowId` (the row let go of for a quick timing).
   - Staged edits: `draftName`, `draftRole` while a row is loaded. `handleUpdate()` writes both with
     `updateAgendaItem` (name, role, rules), so the row and the clock change together;
     `handleUndo()` resets the drafts. Choosing Break still detaches at once (Zoom), as today.
   - Quick timing (no row loaded): name and role apply to the clock directly, as today, and never to
     the agenda. `handleSwitchToQuickTiming()` calls `clearActiveSpeaker` and remembers the row;
     `handleBackToAgenda()` loads it again.
   - `handleSaveToAgenda()` inserts the quick-timed name with its role, via `addPlan`.
   - `handleAddSpeaker(name, role)` (the panel) inserts via `addPlan` and loads only when no speech is
     in progress; otherwise a toast says the speaker comes up after this speech.
   - Enter: in the name field it does what the primary button does (Update by default; with the
     setting on "add", the primary button becomes "Add <name> after <row>"); with no row loaded it
     does nothing. In the add panel it adds.
   - Picking a guest from "In this meeting" opens the add panel with the name filled in; picking an
     agenda row loads it (as today). On the web, picking an agenda suggestion now loads the row.
   - A typed name that exactly matches an agenda row is still never added a second time.
4. **UI, same parts and words on every surface.** A status dot under the name field; the contextual
   buttons (Update + Undo changes, Switch to quick timing, Save to the agenda, Back to agenda); and
   "+ Add a speaker after <row>" opening the add panel.
   - Old look: `SpeakerInput.jsx` (panel); `StageSpeakerPicker.jsx` (stage, compact: status dot,
     field, the Update button when there are changes, "+ Add", with quick timing and Back to agenda
     in its dropdown).
   - New look: `b/TimerCard.jsx` speaker chip carries the status; `b/SpeakerPicker.jsx` popover holds
     the field, buttons, add panel and the Agenda / In this meeting lists. The card's role chip edits
     the speaker on the clock (staged for a loaded row, like the old look's role picker).
   - Web: `SpeakerInput.jsx` and `LiveTab.jsx`.
5. **Settings UI.** Zoom: one `SpeakerEntryOptions` component used by both looks, collapsed
   "Speaker options" under the old look's name field and at the foot of the new look's speaker
   popover (the stage reads the settings, shows none). Web: the same two options under its name field.
6. **Specs.** Add TC-14 (old look) to `timer-core.md` and NL-21 (new look) to `new-look.md`; add
   `SpeakerInput.jsx` and `StageSpeakerPicker.jsx` to `timer-core.md` `covers`. Run TC-14 with
   FLAGS_FORCE `"1,new_look=0"` and NL-21 with `"1,pro=0"`. The web is covered by Playwright
   (`e2e/web.*`), since the Zoom client does not host it.

Rejected: a mode switch, two- or three-way (reads as more tabs); writing a role change to the row at
once (the button would no longer say everything it saves); a "section mode" (out of scope); making
the Agenda tab form follow the insert setting (it builds the running order); a shared React component
(`packages/shared` has none).

## Acceptance criteria
Each criterion holds in the **old look** (panel and stage), the **new look** and the **web Live
tab** (no stage there); the tests below run the same steps through each.

- AC-1: Given the agenda [A, B, C] with B loaded, no speech in progress and the insert setting at its
  default, when a new speaker D is added from the add panel, then the agenda is [A, B, D, C], D is
  loaded, and the timer shows D's role rules.
- AC-2: Given the same agenda and the setting on "at the end", when D is added, then the agenda is
  [A, B, C, D] and D is loaded.
- AC-3: Given no row is loaded and none was let go of, when a speaker is added, then they go to the
  end, whichever setting is on.
- AC-4: Given either setting is changed on one surface, when the user opens another surface or
  reloads, then the same value shows, and both keys are in the synced profile keys.
- AC-5: Given a row is loaded, then a status dot reads "On the agenda · <position> of <total>"; with
  none loaded it reads "Not on the agenda". The status is not a button, and every button's label
  names what tapping it does, with the words from `actionLabels`.
- AC-6: Given B is loaded and the user changes the name to "Dana", then nothing changes on the
  agenda or the clock and the status adds "Unsaved changes", until they tap "Update B on the
  agenda" (or press Enter); then B is renamed on both and keeps its place. "Undo changes" puts the
  fields back with nothing saved.
- AC-7: Given B is loaded, when the user taps "+ Add a speaker after B", then a panel opens with its
  own name and role (the role starts as the one on the clock); "Add D after B" inserts per AC-1/AC-2,
  and the panel never changes B's row or the clock.
- AC-8: Given the Enter setting is at its default, Enter in the name field does what the Update
  button does, and Enter in the add panel adds. With the setting on "add", changing a loaded
  speaker's name makes "Add <name> after B" the primary button (Update stays beside it) and Enter
  adds; B is unchanged. With no row loaded, Enter in the name field does nothing under either setting.
- AC-9: Given B is loaded, when the role is changed (with or without a name change), then the Update
  button lists every change ("name B → Dana · role → Table Topics Speech"); tapping it writes the
  name, the role and its rules to B's row and to the clock together, and the Agenda tab shows them.
  Choosing Break still detaches B at once and leaves the row untouched.
- AC-10: Given the add panel is open, when its role is changed, then the clock's role and B's row
  stay as they were, and the Add button names the role ("as Table Topics Speech").
- AC-11: Given the same sequence of actions on each surface, then the agenda and the timer end up
  identical (a parity test over the shared functions and each surface's handlers, plus the
  real-client steps).
- AC-12: Given the web Live tab, then it has the same controls and rules as the Zoom app (status
  dot, staged Update with Undo, add panel, quick timing, Back to agenda, both settings synced with
  the Zoom app), and picking an agenda suggestion loads its row.
- AC-13: Given B is running (or paused with time on the clock) and the user adds D, then D is
  inserted per AC-1/AC-2 but not loaded, B's timer, label, colour and overlay are untouched, and
  finishing B moves to D.
- AC-14: Given B is loaded, when the user taps "Switch to quick timing", then the timer lets go of B
  (B stays on the agenda, not ticked off), the name field labels the timer only, and a timed speech
  is recorded in the Timer's Report on FINISH with the agenda unchanged; "Back to agenda (next: B,
  B's role)" loads B again.
- AC-15: Given no row is loaded and a name is typed, when the user taps "Save <name> to the agenda",
  then it is inserted with the role shown, after the row let go of or at the end (per AC-1–AC-3), and
  loaded unless a speech is in progress.
- AC-16: Given any state, when START is pressed, then no agenda row is added or changed.

## Test list
| AC | Unit | Playwright | Zoom-client spec |
|---|---|---|---|
| AC-1, 2, 3 | `packages/shared/__tests__/speakerEntry.test.js` (NEW); both `TimerContext.test.jsx` (`insertAfter`); `useLiveTimer.test.jsx` | `e2e/zoom.timer-flow.spec.js` (old look); `e2e/zoom.new-look.spec.js`; `e2e/web.agenda-flow.spec.js` | TC-14 (NEW, old look); NL-21 (NEW, new look) |
| AC-4 | `packages/shared/__tests__/storage.test.js`; `profileMerge.test.js` | `e2e/zoom.new-look.spec.js` (value shared by both looks) | NL-21 |
| AC-5 | `speakerEntry.test.js` (`actionLabels`); zoom `SpeakerInput.test.jsx`, `StageSpeakerPicker.test.jsx`; `b/TimerCard.test.jsx`, `b/Phase3.test.jsx`; web `SpeakerInput.test.jsx` | the three above | TC-14, NL-21 |
| AC-6, 9 | `speakerEntry.test.js` (`pendingChanges`); `useLiveTimer.test.jsx`; both `TimerContext.test.jsx`; web `LiveTab.test.jsx` | the three above | TC-14, NL-21 |
| AC-7, 10 | zoom `SpeakerInput.test.jsx`, `StageSpeakerPicker.test.jsx`; `b/Phase3.test.jsx`; web `SpeakerInput.test.jsx` | the three above | TC-14, NL-21 |
| AC-8 | `useLiveTimer.test.jsx`; web `LiveTab.test.jsx`; the component tests above | `e2e/zoom.timer-flow.spec.js`; `e2e/web.timer-flow.spec.js` | TC-14 |
| AC-11 | `useLiveTimer.test.jsx` and web `LiveTab.test.jsx` run one sequence through `speakerEntry` | — | TC-14 and NL-21 end states compared in `run.md` |
| AC-12 | web `SpeakerInput.test.jsx`, `LiveTab.test.jsx`, `TimerContext.test.jsx` | `e2e/web.timer-flow.spec.js`, `e2e/web.agenda-flow.spec.js` | — |
| AC-13 | `speakerEntry.test.js` (`addPlan`); `useLiveTimer.test.jsx`; web `LiveTab.test.jsx` | `e2e/zoom.timer-flow.spec.js`; `e2e/web.timer-flow.spec.js` | TC-14 (add while running, real video colour unchanged) |
| AC-14, 15 | `useLiveTimer.test.jsx`; both `TimerContext.test.jsx` (report on FINISH without a row); web `LiveTab.test.jsx` | `e2e/zoom.timer-flow.spec.js`; `e2e/zoom.new-look.spec.js`; `e2e/web.report-flow.spec.js` | TC-14, NL-21 |
| AC-16 | `useLiveTimer.test.jsx`; web `LiveTab.test.jsx` | `e2e/zoom.timer-flow.spec.js` | TC-14 |

## Risk
**Low.** No `config.json` `riskHigh` path is touched (`packages/shared/storage.js` and
`profileMerge.js` are not on the list). Size is **medium-large**: three surfaces, two apps. Watch:
- **Behaviour changes users will notice**: with nothing loaded, Enter no longer adds the typed name
  to the agenda (Zoom); a loaded speaker's name and role change on Update, not as you type or pick;
  in the new look, Enter with a row loaded updates instead of adding. Each is visible on screen (the
  status dot, the button's label), and the Enter setting restores adding.
- **Web picks load the row**: on the web, choosing a suggestion now loads its agenda row (as in
  Zoom), so FINISH ticks it off and advances; before, it only copied the name.
- **Synced keys**: two more keys in `SYNCED_KEYS`; `profileMerge.test.js` lists them.
- **Merge conflicts**: new props on `TimerStage.jsx` (to pass the handlers to the stage picker)
  overlap draft PR #143. Whichever merges second rebases; #143 already conflicts with `dev`.

This is the third open factory PR while `wipLimit` is 2: started on the owner's explicit
instruction, Nov 25.

## Open questions
None. Answered Nov 25: Q1–Q8 as under Decisions.
