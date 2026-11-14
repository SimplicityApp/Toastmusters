import { describe, it, expect } from 'vitest';
import { nextStep, pickNext, trustedGates, issueOfBranch } from './state.mjs';

const open = (labels, pr) => nextStep({ issue: { state: 'OPEN', labels }, pr: pr ?? null });

describe('nextStep', () => {
  it.each([
    [[], { gate: 'promote' }],
    [['idea'], { gate: 'promote' }],
    [['factory:ready'], { next: 'plan' }],
    [['factory:ready', 'plan:review'], { gate: 'plan' }],
    [['plan:review', 'plan:approved'], { next: 'build' }],
    [['plan:approved', 'needs:zoom-test'], { next: 'zoom' }],
    [['needs:zoom-test', 'zoom:testing'], { busy: 'zoom', next: null }],
    [['ready-for-review', 'needs:zoom-test'], { gate: 'merge' }],
    [['plan:approved', 'factory:stuck'], { gate: 'stuck' }],
  ])('%j → %j', (labels, want) => {
    expect(open(labels)).toMatchObject(want);
  });

  it('reads the PR labels as well as the issue labels', () => {
    expect(open(['factory:ready'], { state: 'OPEN', labels: ['plan:review'] })).toMatchObject({ gate: 'plan' });
  });

  it('is done when the PR merged or the issue closed', () => {
    expect(open(['ready-for-review'], { state: 'MERGED', labels: [] })).toMatchObject({ next: null, gate: null, reason: 'done' });
    expect(nextStep({ issue: { state: 'CLOSED', labels: ['factory:ready'] }, pr: null })).toMatchObject({ reason: 'done' });
  });

  it('stops on a PR closed without merging', () => {
    expect(open(['plan:approved'], { state: 'CLOSED', labels: [] })).toMatchObject({ gate: 'stuck' });
  });

  it('ignores a human gate an outsider opened', () => {
    const s = nextStep({ issue: { state: 'OPEN', labels: ['factory:ready'] }, pr: null, trusted: [] });
    expect(s).toMatchObject({ next: null, gate: 'promote' });
    expect(s.reason).toContain('not added by a factory actor');
    expect(nextStep({ issue: { state: 'OPEN', labels: ['plan:review', 'plan:approved'] }, pr: null, trusted: ['factory:ready'] }))
      .toMatchObject({ gate: 'plan' });
  });
});

describe('trustedGates', () => {
  it('uses the latest labeled event per gate', () => {
    const events = [
      { label: 'factory:ready', actor: 'stranger' },
      { label: 'factory:ready', actor: 'owner' },
      { label: 'plan:approved', actor: 'owner' },
      { label: 'plan:approved', actor: 'stranger' },
      { label: 'idea', actor: 'stranger' },
    ];
    expect(trustedGates(events, ['owner'])).toEqual(['factory:ready']);
  });
});

describe('pickNext', () => {
  const ready = [{ number: 91 }, { number: 90 }, { number: 105 }];
  it('picks the oldest ready issue without a PR', () => {
    expect(pickNext({ ready, inFlight: [{ issue: 90 }], wipLimit: 2 })).toBe(91);
  });
  it('picks nothing at the WIP limit', () => {
    expect(pickNext({ ready, inFlight: [{ issue: 1 }, { issue: 2 }], wipLimit: 2 })).toBeNull();
  });
});

describe('issueOfBranch', () => {
  it('reads factory/<n>-<slug>', () => {
    expect(issueOfBranch('factory/90-import-role')).toBe(90);
    expect(issueOfBranch('feat/club-card-sets')).toBeNull();
    expect(issueOfBranch('factory/notanumber')).toBeNull();
  });
});
