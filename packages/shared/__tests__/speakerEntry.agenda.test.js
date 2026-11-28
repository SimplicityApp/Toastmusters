import { describe, it, expect } from 'vitest';
import { actionLabels, findOnAgenda, nameFieldAction } from '../speakerEntry.js';

/**
 * #168, the rules speakerEntry.test.js (the oracle) leaves out: a name already
 * on the agenda is never added twice, "Back to agenda" never resets a speech in
 * progress, and "Enter updates too" shows only when Enter does update.
 */

const AGENDA = [
  { id: 'a', name: 'Ana', role: 'Standard Speech', completed: true },
  { id: 'b', name: 'Jordan', role: 'Ice Breaker', completed: false },
  { id: 'c', name: 'Cole', role: 'Standard Speech', completed: false },
];

describe('findOnAgenda', () => {
  it('finds a row still to speak by its exact name, in any case and spacing', () => {
    expect(findOnAgenda(AGENDA, '  jordan ')).toMatchObject({ id: 'b' });
    expect(findOnAgenda(AGENDA, 'Jord')).toBeNull();
    expect(findOnAgenda(AGENDA, '')).toBeNull();
  });

  it('skips a finished row: someone who already spoke can be added again', () => {
    expect(findOnAgenda(AGENDA, 'Ana')).toBeNull();
  });
});

describe('a name already on the agenda is never added twice', () => {
  it('offers no Save for a quick-timed name that is on the agenda, and does for a finished one', () => {
    expect(actionLabels({ agenda: AGENDA, name: 'cole', role: 'Standard Speech' }).save).toBeNull();
    expect(actionLabels({ agenda: AGENDA, name: 'Ana', role: 'Standard Speech' }).save).toBe('Save Ana to the agenda');
  });

  it('says so in the add panel', () => {
    const labels = actionLabels({ agenda: AGENDA, loadedRowId: 'b', name: 'Jordan', role: 'Ice Breaker', addName: 'Cole' });
    expect(labels.addTaken).toBe('Cole is already on the agenda');
    expect(actionLabels({ agenda: AGENDA, loadedRowId: 'b', name: 'Jordan', role: 'Ice Breaker', addName: 'Dana' }).addTaken).toBeNull();
  });

  it('with Enter on "add", Enter does nothing for a name already on the agenda, and says nothing about updating', () => {
    const state = { agenda: AGENDA, loadedRowId: 'b', name: 'Cole', role: 'Ice Breaker', enterAction: 'add' };
    expect(nameFieldAction(state)).toBeNull();
    const labels = actionLabels(state);
    expect(labels.enterAdd).toBeNull();
    expect(labels.updateNote).toBeNull();
    // Update still renames Jordan by hand.
    expect(labels.update).toBe('Update Jordan on the agenda');
  });

  it('with Enter on "add", a role-only change still updates on Enter, and says so', () => {
    const state = { agenda: AGENDA, loadedRowId: 'b', name: 'Jordan', role: 'Table Topics Speech', enterAction: 'add' };
    expect(nameFieldAction(state)).toBe('update');
    expect(actionLabels(state).updateNote).toBe('Enter updates too');
  });
});

describe('"Back to agenda" never resets a speech in progress', () => {
  it('is offered with the timer idle, and not while the quick timing runs or is paused', () => {
    const idle = actionLabels({ agenda: AGENDA, releasedRowId: 'b', name: 'Guest', role: 'Ice Breaker' });
    expect(idle.backToAgenda).toBe('Back to agenda');
    expect(idle.backToAgendaNote).toBe('next: Jordan, Ice Breaker');

    const timing = actionLabels({ agenda: AGENDA, releasedRowId: 'b', name: 'Guest', role: 'Ice Breaker', speechActive: true });
    expect(timing.backToAgenda).toBeNull();
    expect(timing.backToAgendaNote).toBeNull();
    // Saving the guest is still offered; they wait on the agenda.
    expect(timing.save).toBe('Save Guest to the agenda');
  });
});
