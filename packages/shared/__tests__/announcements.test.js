import { describe, it, expect, beforeEach } from 'vitest';
import {
  ANNOUNCEMENTS,
  ANNOUNCEMENTS_DISMISSED_KEY,
  dismissAnnouncement,
  loadDismissedAnnouncements,
  pickAnnouncement,
} from '../announcements.js';

const NOW = Date.UTC(2026, 10, 14, 12);

const plain = { id: 'plain', text: 'Hello.' };
const gated = { id: 'gated', text: 'Only with beta.', when: ({ flags }) => flags.beta === true };
const webOnly = { id: 'web-only', text: 'Web.', surfaces: ['web'] };

beforeEach(() => localStorage.clear());

describe('pickAnnouncement', () => {
  it('returns the first announcement that applies to this surface', () => {
    const picked = pickAnnouncement({ surface: 'zoom', announcements: [webOnly, plain, gated], now: NOW, dismissed: [] });
    expect(picked.id).toBe('plain');
    expect(pickAnnouncement({ surface: 'web', announcements: [webOnly, plain], now: NOW, dismissed: [] }).id).toBe('web-only');
  });

  it('defaults to the Zoom app only', () => {
    expect(pickAnnouncement({ surface: 'web', announcements: [plain], now: NOW, dismissed: [] })).toBeNull();
  });

  it('skips one this device closed, and moves on to the next', () => {
    const list = [plain, { id: 'second', text: 'Next.' }];
    expect(pickAnnouncement({ surface: 'zoom', announcements: list, now: NOW, dismissed: ['plain'] }).id).toBe('second');
    expect(pickAnnouncement({ surface: 'zoom', announcements: list, now: NOW, dismissed: ['plain', 'second'] })).toBeNull();
  });

  it('waits for the flags before a gated one, so it never flashes', () => {
    expect(pickAnnouncement({ surface: 'zoom', announcements: [gated], now: NOW, dismissed: [], flagsKnown: false, flags: { beta: true } })).toBeNull();
    expect(pickAnnouncement({ surface: 'zoom', announcements: [gated], now: NOW, dismissed: [], flagsKnown: true, flags: { beta: true } }).id).toBe('gated');
    expect(pickAnnouncement({ surface: 'zoom', announcements: [gated], now: NOW, dismissed: [], flagsKnown: true, flags: {} })).toBeNull();
  });

  it('shows an ungated one before the flags arrive', () => {
    expect(pickAnnouncement({ surface: 'zoom', announcements: [plain], now: NOW, dismissed: [], flagsKnown: false }).id).toBe('plain');
  });

  it('keeps to its dates: from starts, until ends', () => {
    const dated = { id: 'dated', text: 'Soon.', starts: '2026-11-14T00:00:00Z', ends: '2026-11-21T00:00:00Z' };
    const at = (iso) => pickAnnouncement({ surface: 'zoom', announcements: [dated], now: Date.parse(iso), dismissed: [] });
    expect(at('2026-11-13T23:59:59Z')).toBeNull();
    expect(at('2026-11-14T00:00:00Z').id).toBe('dated');
    expect(at('2026-11-20T23:59:59Z').id).toBe('dated');
    expect(at('2026-11-21T00:00:00Z')).toBeNull();
  });

  it('hides one whose condition throws, and shows the next', () => {
    const broken = { id: 'broken', text: 'x', when: () => { throw new Error('bad'); } };
    expect(pickAnnouncement({ surface: 'zoom', announcements: [broken, plain], now: NOW, dismissed: [], flagsKnown: true }).id).toBe('plain');
  });

  it('ignores entries without an id or text', () => {
    expect(pickAnnouncement({ surface: 'zoom', announcements: [{ text: 'no id' }, { id: 'no-text' }], now: NOW, dismissed: [] })).toBeNull();
  });

  it('reads this device\'s dismissals by default', () => {
    dismissAnnouncement('plain');
    expect(pickAnnouncement({ surface: 'zoom', announcements: [plain], now: NOW })).toBeNull();
  });
});

describe('the shipped pre-launch announcement', () => {
  const preLaunch = ANNOUNCEMENTS.find((a) => a.id === 'pre-launch-2026-11');

  it('says a new look and Pro are coming', () => {
    expect(`${preLaunch.lead} ${preLaunch.text}`).toBe(
      'Coming soon: a fresh new look for the timer, and Pro features for your club.',
    );
  });

  it('shows in the Zoom app while pro is off, and retires at launch', () => {
    const pick = (flags) => pickAnnouncement({ surface: 'zoom', flags, flagsKnown: true, dismissed: [], now: NOW });
    expect(pick({ pro: false, sounds: true })?.id).toBe('pre-launch-2026-11');
    expect(pick({ pro: true, sounds: true })).toBeNull();
  });

  it('gives way to the new-look note for anyone already on design B', () => {
    const pick = (flags) => pickAnnouncement({ surface: 'zoom', flags, flagsKnown: true, dismissed: [], now: NOW });
    const note = pick({ pro: false, sounds: true, new_look: true });
    expect(note?.id).toBe('new-look-2026-11');
    expect(`${note.lead} ${note.text}`).toBe(
      'New look: the timer sits in the middle now, with your settings under Look & sound. Pro is coming soon.',
    );
    expect(pick({ pro: true, new_look: true })).toBeNull();
    // Closing the new-look note does not bring the pre-launch one back.
    expect(pickAnnouncement({ surface: 'zoom', flags: { pro: false, new_look: true }, flagsKnown: true, dismissed: ['new-look-2026-11'], now: NOW })).toBeNull();
  });

  it('has unique ids across the list', () => {
    const ids = ANNOUNCEMENTS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('dismissals', () => {
  it('remember each id once, per device', () => {
    expect(loadDismissedAnnouncements()).toEqual([]);
    expect(dismissAnnouncement('a')).toBe(true);
    expect(dismissAnnouncement('a')).toBe(true);
    dismissAnnouncement('b');
    expect(loadDismissedAnnouncements()).toEqual(['a', 'b']);
    expect(JSON.parse(localStorage.getItem(ANNOUNCEMENTS_DISMISSED_KEY))).toEqual(['a', 'b']);
  });

  it('read garbage as nothing closed', () => {
    localStorage.setItem(ANNOUNCEMENTS_DISMISSED_KEY, '{not json');
    expect(loadDismissedAnnouncements()).toEqual([]);
    localStorage.setItem(ANNOUNCEMENTS_DISMISSED_KEY, JSON.stringify({ a: 1 }));
    expect(loadDismissedAnnouncements()).toEqual([]);
    localStorage.setItem(ANNOUNCEMENTS_DISMISSED_KEY, JSON.stringify(['a', 3, null]));
    expect(loadDismissedAnnouncements()).toEqual(['a']);
  });
});
