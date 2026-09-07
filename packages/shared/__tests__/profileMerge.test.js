import { describe, it, expect } from 'vitest';
import {
  SYNCED_KEYS,
  normalizeProfile,
  mergeProfiles,
  fieldsToApplyLocally,
} from '../profileMerge.js';

const entry = (value, updatedAt) => ({ value, updatedAt });
const profile = (fields, rev = 0) => ({ rev, fields });

describe('normalizeProfile', () => {
  it('keeps valid entries for known keys', () => {
    const result = normalizeProfile(
      profile({ toastmaster_role_rules: entry({ a: 1 }, 100) }, 3)
    );

    expect(result).toEqual({ rev: 3, fields: { toastmaster_role_rules: entry({ a: 1 }, 100) } });
  });

  // Without this the document is a bucket any client can grow without limit.
  it('drops keys that are not in the synced set', () => {
    const result = normalizeProfile(
      profile({ toastmaster_role_rules: entry(1, 100), attacker_junk: entry('x', 200) })
    );

    expect(Object.keys(result.fields)).toEqual(['toastmaster_role_rules']);
  });

  // Reports carry no id and no timestamp, so there is nothing sound to merge on.
  it('does not sync reports', () => {
    expect(SYNCED_KEYS).not.toContain('toastmaster_reports');
    expect(normalizeProfile(profile({ toastmaster_reports: entry([], 100) })).fields).toEqual({});
  });

  it('drops entries with no usable timestamp', () => {
    const result = normalizeProfile(
      profile({
        toastmaster_agenda: { value: 1 },
        toastmaster_role_rules: { value: 1, updatedAt: 'soon' },
        toastmaster_overlay_mode: { value: 1, updatedAt: Number.NaN },
        toastmaster_prompts: { updatedAt: 100 },
      })
    );

    expect(result.fields).toEqual({});
  });

  it('degrades a corrupt document to an empty profile rather than throwing', () => {
    for (const junk of [null, undefined, 'a string', 42, [], { fields: 'nope' }]) {
      expect(normalizeProfile(junk)).toEqual({ rev: 0, fields: {} });
    }
  });

  // A value can legitimately be null (a preference explicitly cleared).
  it('keeps a null value, which is different from an absent field', () => {
    const result = normalizeProfile(profile({ toastmaster_overlay_mode: entry(null, 100) }));

    expect(result.fields.toastmaster_overlay_mode).toEqual(entry(null, 100));
  });
});

describe('mergeProfiles', () => {
  it('takes the newer write per field', () => {
    const base = profile({
      toastmaster_role_rules: entry('old', 100),
      toastmaster_overlay_mode: entry('camera', 500),
    });
    const incoming = profile({
      toastmaster_role_rules: entry('new', 200),
      toastmaster_overlay_mode: entry('card', 400),
    });

    const { profile: merged, changed } = mergeProfiles(base, incoming);

    expect(changed).toBe(true);
    expect(merged.fields.toastmaster_role_rules).toEqual(entry('new', 200));
    // Older write loses even though it arrived later.
    expect(merged.fields.toastmaster_overlay_mode).toEqual(entry('camera', 500));
  });

  // The whole reason for per-field rather than whole-document LWW.
  it('does not let a stale device clobber fields it never touched', () => {
    const desktop = profile({
      toastmaster_role_rules: entry('tuned', 9_000),
      toastmaster_overlay_mode: entry('camera', 9_000),
    });
    // A laptop that has been closed for a week, writing one old preference.
    const laptop = profile({ toastmaster_overlay_mode: entry('card', 1_000) });

    const { profile: merged } = mergeProfiles(desktop, laptop);

    expect(merged.fields.toastmaster_role_rules).toEqual(entry('tuned', 9_000));
    expect(merged.fields.toastmaster_overlay_mode).toEqual(entry('camera', 9_000));
  });

  it('adds fields the base has never seen', () => {
    const { profile: merged, changed } = mergeProfiles(
      profile({}),
      profile({ toastmaster_agenda: entry([1], 100) })
    );

    expect(changed).toBe(true);
    expect(merged.fields.toastmaster_agenda).toEqual(entry([1], 100));
  });

  it('reports no change and does not bump rev when nothing is newer', () => {
    const base = profile({ toastmaster_agenda: entry('x', 500) }, 7);

    const { profile: merged, changed } = mergeProfiles(base, profile({ toastmaster_agenda: entry('y', 100) }));

    expect(changed).toBe(false);
    expect(merged.rev).toBe(7);
    expect(merged.fields.toastmaster_agenda).toEqual(entry('x', 500));
  });

  it('bumps rev exactly once per merge that changes something', () => {
    const { profile: merged } = mergeProfiles(
      profile({}, 4),
      profile({ toastmaster_agenda: entry(1, 10), toastmaster_prompts: entry(2, 20) })
    );

    expect(merged.rev).toBe(5);
  });

  // Retries must not flip a field back and forth.
  it('is idempotent when the same document is written twice', () => {
    const incoming = profile({ toastmaster_agenda: entry('v', 100) });
    const once = mergeProfiles(profile({}), incoming);
    const twice = mergeProfiles(once.profile, incoming);

    expect(twice.changed).toBe(false);
    expect(twice.profile).toEqual(once.profile);
  });

  it('ignores unknown keys arriving from a client', () => {
    const { profile: merged } = mergeProfiles(profile({}), profile({ evil: entry('x', 999) }));

    expect(merged.fields).toEqual({});
  });
});

describe('fieldsToApplyLocally', () => {
  it('returns only the fields where the remote copy is newer', () => {
    const local = profile({
      toastmaster_agenda: entry('mine', 500),
      toastmaster_prompts: entry('mine', 100),
    });
    const remote = profile({
      toastmaster_agenda: entry('theirs', 200),
      toastmaster_prompts: entry('theirs', 900),
      toastmaster_role_rules: entry('theirs', 1),
    });

    expect(fieldsToApplyLocally(local, remote)).toEqual({
      toastmaster_prompts: entry('theirs', 900),
      toastmaster_role_rules: entry('theirs', 1),
    });
  });

  // A local edit made while the request was in flight must survive the reply.
  it('never clobbers a local field that is newer', () => {
    const local = profile({ toastmaster_overlay_mode: entry('just-set', 1_000) });
    const remote = profile({ toastmaster_overlay_mode: entry('stale', 999) });

    expect(fieldsToApplyLocally(local, remote)).toEqual({});
  });

  it('applies everything when the device has nothing yet', () => {
    const remote = profile({ toastmaster_agenda: entry('a', 1) });

    expect(fieldsToApplyLocally(null, remote)).toEqual({ toastmaster_agenda: entry('a', 1) });
  });
});
