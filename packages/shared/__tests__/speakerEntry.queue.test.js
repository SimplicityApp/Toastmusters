import { describe, it, expect } from 'vitest';
import { afterQueue, actionLabels, insertAfter, addPlan } from '../speakerEntry.js';

/**
 * #168: speakers added while a speech runs wait on the agenda; the next one goes
 * behind them, so they speak in the order they were added (B running, add D then
 * E: B, D, E, not B, E, D).
 */

const row = (id, name, extra = {}) => ({ id, name, role: 'Standard Speech', completed: false, ...extra });
const AGENDA = [row('a', 'Ana'), row('b', 'Jordan'), row('d', 'Dana'), row('e', 'Evan'), row('c', 'Cole')];

describe('afterQueue', () => {
  it('is the anchor itself when nobody waits behind it', () => {
    expect(afterQueue(AGENDA, 'b', [])).toBe('b');
    expect(afterQueue(AGENDA, 'b')).toBe('b');
  });

  it('skips the unbroken run of waiting speakers right behind the anchor', () => {
    expect(afterQueue(AGENDA, 'b', ['d'])).toBe('d');
    expect(afterQueue(AGENDA, 'b', ['d', 'e'])).toBe('e');
    expect(afterQueue(AGENDA, 'b', ['e', 'd'])).toBe('e');
  });

  it('stops at the first row that is not waiting', () => {
    expect(afterQueue(AGENDA, 'b', ['e'])).toBe('b');
    expect(afterQueue(AGENDA, 'a', ['d', 'e'])).toBe('a');
  });

  it('does not skip to a waiting speaker who is already ticked off', () => {
    const done = AGENDA.map((r) => (r.id === 'd' ? { ...r, completed: true } : r));
    expect(afterQueue(done, 'b', ['d', 'e'])).toBe('b');
  });

  it('starts from a waiting speaker who has become the anchor', () => {
    expect(afterQueue(AGENDA, 'd', ['d', 'e'])).toBe('e');
  });

  it('is null with no anchor, and passes a missing anchor through so the speaker is appended', () => {
    expect(afterQueue(AGENDA, null, ['d'])).toBeNull();
    expect(afterQueue(AGENDA, undefined, ['d'])).toBeNull();
    expect(afterQueue(AGENDA, 'gone', ['d'])).toBe('gone');
    expect(insertAfter(AGENDA, afterQueue(AGENDA, 'gone', ['d']), row('f', 'Fay')).at(-1).name).toBe('Fay');
  });

  it('puts two speakers added in turn in the order added', () => {
    let agenda = [row('a', 'Ana'), row('b', 'Jordan'), row('c', 'Cole')];
    const waiting = [];
    for (const [id, name] of [['d', 'Dana'], ['e', 'Evan'], ['f', 'Fay']]) {
      const plan = addPlan({ speechActive: true, anchorId: afterQueue(agenda, 'b', waiting) });
      agenda = insertAfter(agenda, plan.insertAfter, row(id, name));
      waiting.push(id);
    }
    expect(agenda.map((r) => r.name)).toEqual(['Ana', 'Jordan', 'Dana', 'Evan', 'Fay', 'Cole']);
  });
});

describe('actionLabels with waiting speakers', () => {
  const state = { agenda: AGENDA, loadedRowId: 'b', name: 'Jordan', role: 'Standard Speech', speechActive: true };

  it('names the row the next speaker really goes behind', () => {
    expect(actionLabels({ ...state, waitingIds: [] }).addOpener).toBe('Add a speaker after Jordan');
    expect(actionLabels({ ...state, waitingIds: ['d'] }).addOpener).toBe('Add a speaker after Dana');
    expect(actionLabels({ ...state, waitingIds: ['d', 'e'], addName: 'Fay', addRole: 'Table Topics Speech' }).addAction)
      .toBe('Add Fay after Evan');
  });

  it('keeps naming the loaded row when no speech is in progress: the new speaker goes on the timer right after it', () => {
    expect(actionLabels({ ...state, speechActive: false, waitingIds: ['d', 'e'] }).addOpener).toBe('Add a speaker after Jordan');
  });

  it('still says "at the end" with that setting on', () => {
    expect(actionLabels({ ...state, insertPosition: 'end', waitingIds: ['d'] }).addOpener).toBe('Add a speaker at the end');
  });
});
