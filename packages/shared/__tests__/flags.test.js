import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  DEFAULT_FLAGS,
  setFlags,
  getFlags,
  isFlagOn,
  areFlagsKnown,
  subscribeFlags,
  resetFlagsForTests,
} from '../flags.js';
import * as shared from '../index.js';

beforeEach(() => resetFlagsForTests());

describe('flag store', () => {
  it('starts unknown and all off', () => {
    expect(getFlags()).toEqual(DEFAULT_FLAGS);
    expect(areFlagsKnown()).toBe(false);
    expect(isFlagOn('pro')).toBe(false);
  });

  it('records the server answer and becomes known', () => {
    setFlags({ pro: true });
    expect(areFlagsKnown()).toBe(true);
    expect(isFlagOn('pro')).toBe(true);
    expect(getFlags()).toEqual({ pro: true });
  });

  // An answer that says nothing usable still counts as an answer: the client
  // now knows, and what it knows is "off".
  it('normalises junk to all off, and still becomes known', () => {
    for (const junk of [null, undefined, 'pro', 42, ['pro'], true]) {
      resetFlagsForTests();
      setFlags(junk);
      expect(areFlagsKnown()).toBe(true);
      expect(getFlags()).toEqual(DEFAULT_FLAGS);
      expect(isFlagOn('pro')).toBe(false);
    }
  });

  it('treats anything but a literal true as off', () => {
    setFlags({ a: true, b: 'true', c: 1, d: {}, e: false, f: null });
    expect(getFlags()).toEqual({ a: true, b: false, c: false, d: false, e: false, f: false });
    expect(isFlagOn('a')).toBe(true);
    for (const key of ['b', 'c', 'd', 'e', 'f', 'never_sent']) expect(isFlagOn(key)).toBe(false);
  });

  it('hands out a snapshot nobody can edit in place', () => {
    setFlags({ pro: false });
    expect(Object.isFrozen(getFlags())).toBe(true);
  });

  // useSyncExternalStore re-renders on a changed snapshot and loops on one that
  // changes every call, so the same answer must be the same object.
  it('keeps the snapshot stable between answers', () => {
    setFlags({ pro: true });
    expect(getFlags()).toBe(getFlags());
  });

  it('notifies subscribers, and stops after unsubscribe', () => {
    const seen = [];
    const unsubscribe = subscribeFlags((flags) => seen.push(flags));

    setFlags({ pro: true });
    expect(seen).toEqual([{ pro: true }]);

    unsubscribe();
    setFlags({ pro: false });
    expect(seen).toHaveLength(1);
  });

  it('keeps notifying when one subscriber throws', () => {
    subscribeFlags(() => { throw new Error('boom'); });
    const ok = vi.fn();
    subscribeFlags(ok);
    setFlags({ pro: true });
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it('resets to unknown and all off, and forgets subscribers', () => {
    const listener = vi.fn();
    subscribeFlags(listener);
    setFlags({ pro: true });
    resetFlagsForTests();

    expect(areFlagsKnown()).toBe(false);
    expect(isFlagOn('pro')).toBe(false);
    setFlags({ pro: true });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('is exported from the package root', () => {
    for (const name of ['setFlags', 'getFlags', 'isFlagOn', 'areFlagsKnown', 'subscribeFlags', 'resetFlagsForTests']) {
      expect(typeof shared[name]).toBe('function');
    }
  });
});
