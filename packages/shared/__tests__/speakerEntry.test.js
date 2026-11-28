import { describe, it, expect, beforeAll } from 'vitest';

/**
 * On-the-spot speakers (#168): the pure half, in packages/shared/speakerEntry.js.
 * Every surface (the Zoom app's old look, panel and stage; its new look; the web
 * Live tab) builds its speaker control from these, so they all insert in the same
 * place and say the same words.
 *
 *   insertAfter(agenda, afterId, item)      a new agenda with item right after afterId;
 *                                           appended when afterId is null or not found
 *   addPlan({ speechActive, insertPosition, anchorId })
 *                                           -> { insertAfter, activate }. The anchor is the
 *                                           loaded row, or the row let go of for a quick
 *                                           timing. 'end' (the setting) or no anchor appends.
 *                                           Never activate while a speech is in progress.
 *   pendingChanges({ row, name, role })     -> { name?, role? } staged against the row, or null
 *   actionLabels(state)                     the words every surface shows. `state` is
 *     {
 *       agenda,          the agenda array
 *       loadedRowId,     the row on the clock (activeSpeakerId), or null
 *       releasedRowId,   the row let go of for a quick timing, or null
 *       name, role,      what the name field and the role picker show (the staged edit
 *                        while a row is loaded; the clock's label in quick timing)
 *       addName, addRole the add panel's own name and role
 *       enterAction,     'update' (default) | 'add'
 *       insertPosition,  'afterActive' (default) | 'end'
 *     }
 *   and returns an object of strings. These tests read every string in it,
 *   wherever it sits, so the key names are the implementer's to choose.
 *
 * Loaded dynamically so a missing module fails these assertions one by one
 * rather than the whole file at import.
 */

// A variable, so the bundler does not refuse the file before speakerEntry.js exists.
const SPEAKER_ENTRY_MODULE = '../speakerEntry.js';
let entry = {};
beforeAll(async () => {
  entry = await import(/* @vite-ignore */ SPEAKER_ENTRY_MODULE).catch(() => ({}));
});

const fn = (name) => {
  expect(typeof entry[name], `speakerEntry.js exports ${name}()`).toBe('function');
  return entry[name];
};

const ANA = { id: 'a', name: 'Ana', role: 'Standard Speech', completed: false };
const JORDAN = { id: 'b', name: 'Jordan', role: 'Ice Breaker', completed: false };
const COLE = { id: 'c', name: 'Cole', role: 'Standard Speech', completed: false };
const AGENDA = [ANA, JORDAN, COLE];
const DANA = { id: 'd', name: 'Dana', role: 'Table Topics Speech', completed: false };

const names = (agenda) => agenda.map((item) => item.name);

/** Every string anywhere in the labels object, nested or not. */
function allStrings(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(allStrings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(allStrings);
  return [];
}

const labelsFor = (state) =>
  allStrings(
    fn('actionLabels')({
      agenda: AGENDA,
      loadedRowId: null,
      releasedRowId: null,
      name: '',
      role: 'Standard Speech',
      addName: '',
      addRole: 'Standard Speech',
      enterAction: 'update',
      insertPosition: 'afterActive',
      ...state,
    })
  );

describe('insertAfter', () => {
  it('AC-1: puts the new speaker right after the given row, and keeps the rest in order', () => {
    const result = fn('insertAfter')(AGENDA, 'b', DANA);
    expect(names(result)).toEqual(['Ana', 'Jordan', 'Dana', 'Cole']);
  });

  it('does not change the agenda it was given', () => {
    const before = AGENDA.map((item) => ({ ...item }));
    fn('insertAfter')(AGENDA, 'b', DANA);
    expect(AGENDA).toEqual(before);
  });

  it('AC-3: appends when there is no row to go after', () => {
    expect(names(fn('insertAfter')(AGENDA, null, DANA))).toEqual(['Ana', 'Jordan', 'Cole', 'Dana']);
    expect(names(fn('insertAfter')(AGENDA, undefined, DANA))).toEqual(['Ana', 'Jordan', 'Cole', 'Dana']);
  });

  it('appends when the row is no longer on the agenda', () => {
    expect(names(fn('insertAfter')(AGENDA, 'gone', DANA))).toEqual(['Ana', 'Jordan', 'Cole', 'Dana']);
  });

  it('after the last row is the end', () => {
    expect(names(fn('insertAfter')(AGENDA, 'c', DANA))).toEqual(['Ana', 'Jordan', 'Cole', 'Dana']);
  });
});

describe('addPlan', () => {
  it('AC-1: by default, after the anchor, and the new speaker is loaded', () => {
    const plan = fn('addPlan')({ speechActive: false, insertPosition: 'afterActive', anchorId: 'b' });
    expect(plan.insertAfter).toBe('b');
    expect(plan.activate).toBe(true);
  });

  it('AC-1: the default setting is after the anchor', () => {
    const plan = fn('addPlan')({ speechActive: false, anchorId: 'b' });
    expect(plan.insertAfter).toBe('b');
  });

  it('AC-2: with the setting on "at the end", appends and still loads', () => {
    const plan = fn('addPlan')({ speechActive: false, insertPosition: 'end', anchorId: 'b' });
    expect(plan.insertAfter ?? null).toBeNull();
    expect(plan.activate).toBe(true);
  });

  it('AC-3: with no anchor, appends whichever setting is on', () => {
    for (const insertPosition of ['afterActive', 'end']) {
      const plan = fn('addPlan')({ speechActive: false, insertPosition, anchorId: null });
      expect(plan.insertAfter ?? null, insertPosition).toBeNull();
      expect(plan.activate, insertPosition).toBe(true);
    }
  });

  it('AC-13: while a speech is in progress, inserts in the same place but never loads', () => {
    const afterActive = fn('addPlan')({ speechActive: true, insertPosition: 'afterActive', anchorId: 'b' });
    expect(afterActive.insertAfter).toBe('b');
    expect(afterActive.activate).toBe(false);

    const atEnd = fn('addPlan')({ speechActive: true, insertPosition: 'end', anchorId: 'b' });
    expect(atEnd.insertAfter ?? null).toBeNull();
    expect(atEnd.activate).toBe(false);
  });
});

describe('pendingChanges', () => {
  it('AC-6: nothing staged when the fields still match the row', () => {
    expect(fn('pendingChanges')({ row: JORDAN, name: 'Jordan', role: 'Ice Breaker' })).toBeNull();
  });

  it('AC-6: a new name is staged', () => {
    expect(fn('pendingChanges')({ row: JORDAN, name: 'Dana', role: 'Ice Breaker' })).toEqual({ name: 'Dana' });
  });

  it('AC-9: a new role is staged', () => {
    expect(fn('pendingChanges')({ row: JORDAN, name: 'Jordan', role: 'Table Topics Speech' })).toEqual({
      role: 'Table Topics Speech',
    });
  });

  it('AC-9: both, when both changed', () => {
    expect(fn('pendingChanges')({ row: JORDAN, name: 'Dana', role: 'Table Topics Speech' })).toEqual({
      name: 'Dana',
      role: 'Table Topics Speech',
    });
  });

  it('ignores spaces around the name, and never stages an empty name', () => {
    expect(fn('pendingChanges')({ row: JORDAN, name: '  Jordan ', role: 'Ice Breaker' })).toBeNull();
    expect(fn('pendingChanges')({ row: JORDAN, name: ' Dana ', role: 'Ice Breaker' })).toEqual({ name: 'Dana' });
    expect(fn('pendingChanges')({ row: JORDAN, name: '', role: 'Ice Breaker' })).toBeNull();
  });

  it('nothing to stage without a loaded row (quick timing)', () => {
    expect(fn('pendingChanges')({ row: null, name: 'Dana', role: 'Ice Breaker' })).toBeNull();
  });
});

describe('actionLabels', () => {
  it('AC-5: a loaded row with nothing staged: status, quick timing with its note, the add panel', () => {
    const strings = labelsFor({ loadedRowId: 'b', name: 'Jordan', role: 'Ice Breaker' });
    expect(strings).toContain('On the agenda · 2 of 3');
    expect(strings).toContain('Switch to quick timing');
    expect(strings).toContain('Jordan stays on the agenda, not ticked off');
    expect(strings).toContain('Add a speaker after Jordan');

    expect(strings).not.toContain('Not on the agenda');
    expect(strings).not.toContain('Unsaved changes');
    expect(strings.filter((s) => s.startsWith('Update '))).toEqual([]);
    expect(strings.filter((s) => s.startsWith('Save '))).toEqual([]);
  });

  it('AC-6/AC-9: staged edits: Unsaved changes, Update with every change listed, Undo changes', () => {
    const strings = labelsFor({ loadedRowId: 'b', name: 'Dana', role: 'Table Topics Speech' });
    expect(strings).toContain('On the agenda · 2 of 3');
    expect(strings).toContain('Unsaved changes');
    expect(strings).toContain('Update Jordan on the agenda');
    expect(strings).toContain('Undo changes');
    expect(strings.some((s) => s.includes('name Jordan → Dana · role → Table Topics Speech'))).toBe(true);
  });

  it('AC-9: a role change alone lists only the role', () => {
    const strings = labelsFor({ loadedRowId: 'b', name: 'Jordan', role: 'Table Topics Speech' });
    expect(strings).toContain('Update Jordan on the agenda');
    expect(strings.some((s) => s.includes('role → Table Topics Speech'))).toBe(true);
    expect(strings.some((s) => s.includes('name Jordan →'))).toBe(false);
  });

  it('AC-8: with the Enter setting on "add", a changed name offers "Add <name> after <row>" beside Update', () => {
    const strings = labelsFor({ loadedRowId: 'b', name: 'Dana', role: 'Ice Breaker', enterAction: 'add' });
    expect(strings).toContain('Add Dana after Jordan');
    expect(strings).toContain('Update Jordan on the agenda');
  });

  it('AC-7/AC-10: the add panel names who goes where, and the role', () => {
    const strings = labelsFor({
      loadedRowId: 'b',
      name: 'Jordan',
      role: 'Ice Breaker',
      addName: 'Dana',
      addRole: 'Table Topics Speech',
    });
    expect(strings.some((s) => s.startsWith('Add Dana after Jordan'))).toBe(true);
    expect(strings.some((s) => s.includes('as Table Topics Speech'))).toBe(true);
  });

  it('AC-5: nothing loaded and nothing let go of: "Not on the agenda", and a typed name can be saved', () => {
    const strings = labelsFor({ name: 'Dana', role: 'Standard Speech' });
    expect(strings).toContain('Not on the agenda');
    expect(strings).toContain('Save Dana to the agenda');
    expect(strings.some((s) => s.startsWith('On the agenda'))).toBe(false);
    expect(strings.some((s) => s.startsWith('Back to agenda'))).toBe(false);
  });

  it('AC-14: a row let go of for a quick timing offers the way back, naming who is next', () => {
    const strings = labelsFor({ releasedRowId: 'b', name: '', role: 'Ice Breaker' });
    expect(strings).toContain('Not on the agenda');
    expect(strings.some((s) => s.startsWith('Back to agenda'))).toBe(true);
    expect(strings.some((s) => s.includes('next: Jordan, Ice Breaker'))).toBe(true);
    // Nothing typed yet, so nothing to save.
    expect(strings.filter((s) => s.startsWith('Save '))).toEqual([]);
  });

  it('AC-15: a quick-timed name can be saved, with the way back still offered', () => {
    const strings = labelsFor({ releasedRowId: 'b', name: 'Eve', role: 'Ice Breaker' });
    expect(strings).toContain('Save Eve to the agenda');
    expect(strings.some((s) => s.startsWith('Back to agenda'))).toBe(true);
  });

  it('counts the position from the agenda as it is', () => {
    const agenda = fn('insertAfter')(AGENDA, 'b', DANA);
    const strings = allStrings(
      fn('actionLabels')({
        agenda,
        loadedRowId: 'd',
        releasedRowId: null,
        name: 'Dana',
        role: 'Table Topics Speech',
        addName: '',
        addRole: 'Table Topics Speech',
        enterAction: 'update',
        insertPosition: 'afterActive',
      })
    );
    expect(strings).toContain('On the agenda · 3 of 4');
  });
});

describe('AC-11: one sequence, one end state', () => {
  // The same sequence the surface tests run (useLiveTimer.test.jsx, the Zoom and
  // web LiveTab.speakerEntry tests, b/TimerTab.speakerEntry.test.jsx): load
  // Jordan, add Dana after him as Table Topics Speech, rename her to Dane, let go
  // of her for a quick timing and save Eve. Every surface must end on this agenda.
  it('Ana, Jordan, Dane, Eve, Cole', () => {
    const insert = fn('insertAfter');
    const plan = fn('addPlan');

    let agenda = AGENDA;
    const add = plan({ speechActive: false, insertPosition: 'afterActive', anchorId: 'b' });
    agenda = insert(agenda, add.insertAfter, DANA);
    agenda = agenda.map((item) => (item.id === 'd' ? { ...item, name: 'Dane' } : item));
    const save = plan({ speechActive: false, insertPosition: 'afterActive', anchorId: 'd' });
    agenda = insert(agenda, save.insertAfter, { id: 'e', name: 'Eve', role: 'Table Topics Speech', completed: false });

    expect(names(agenda)).toEqual(['Ana', 'Jordan', 'Dane', 'Eve', 'Cole']);
    expect(agenda.map((item) => item.role)).toEqual([
      'Standard Speech',
      'Ice Breaker',
      'Table Topics Speech',
      'Table Topics Speech',
      'Standard Speech',
    ]);
    expect(add.activate && save.activate).toBe(true);
  });
});
