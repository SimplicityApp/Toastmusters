import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  SOUND_SETTINGS_KEY,
  DEFAULT_SOUND_SETTINGS,
  BREAK_TRACKS,
  CUE_PATTERNS,
  MUSIC_BOX_LOOP,
  normalizeSoundSettings,
  getSoundSettings,
  updateSoundSettings,
  subscribeSoundSettings,
  resetSoundSettingsForTests,
  cueForStatusChange,
  shouldPlayBreakMusic,
  noteToFrequency,
  createSoundEngine,
} from '../timerSounds.js';
import { BREAK_ROLE } from '../timingRules.js';
import * as shared from '../index.js';

/** Enough of an AudioContext to record what would have sounded. */
function fakeAudioContext() {
  const param = () => ({
    value: 1,
    setValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    cancelScheduledValues: vi.fn(),
  });
  const ctx = {
    currentTime: 0,
    state: 'running',
    destination: {},
    resume: vi.fn(() => Promise.resolve()),
    oscillators: [],
    createOscillator() {
      const osc = { frequency: param(), connect: vi.fn(), start: vi.fn(), stop: vi.fn() };
      ctx.oscillators.push(osc);
      return osc;
    },
    createGain() {
      return { gain: param(), connect: vi.fn(), disconnect: vi.fn() };
    },
  };
  return ctx;
}

const frequencies = (ctx) => ctx.oscillators.map((o) => o.frequency.setValueAtTime.mock.calls[0][0]);

beforeEach(() => {
  localStorage.clear();
  resetSoundSettingsForTests();
});

describe('sound settings', () => {
  it('start off, so nothing sounds until asked', () => {
    expect(getSoundSettings()).toEqual(DEFAULT_SOUND_SETTINGS);
    expect(DEFAULT_SOUND_SETTINGS.cues).toBe(false);
    expect(DEFAULT_SOUND_SETTINGS.music).toBe(false);
  });

  it('save, reload and notify', () => {
    const listener = vi.fn();
    subscribeSoundSettings(listener);
    updateSoundSettings({ cues: true, volume: 0.4 });
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ cues: true, volume: 0.4 }));

    resetSoundSettingsForTests();
    expect(getSoundSettings()).toMatchObject({ cues: true, music: false, volume: 0.4 });
  });

  it('keep the same object between changes (useSyncExternalStore)', () => {
    expect(getSoundSettings()).toBe(getSoundSettings());
  });

  it('survive garbage in storage', () => {
    localStorage.setItem(SOUND_SETTINGS_KEY, '{not json');
    expect(getSoundSettings()).toEqual(DEFAULT_SOUND_SETTINGS);
  });

  it('clamp volume and fall back from a removed track', () => {
    expect(normalizeSoundSettings({ volume: 3, track: 'gone' })).toMatchObject({
      volume: 1,
      track: BREAK_TRACKS[0].id,
    });
    expect(normalizeSoundSettings({ volume: -1 }).volume).toBe(0);
    expect(normalizeSoundSettings({ cues: 'yes' }).cues).toBe(false);
  });

  it('are exported from the package', () => {
    expect(shared.updateSoundSettings).toBe(updateSoundSettings);
  });
});

describe('cueForStatusChange', () => {
  it('chimes each step forward', () => {
    expect(cueForStatusChange('blue', 'green')).toBe('green');
    expect(cueForStatusChange('green', 'yellow')).toBe('yellow');
    expect(cueForStatusChange('yellow', 'red')).toBe('red');
  });

  it('chimes the card reached when it jumps ahead', () => {
    expect(cueForStatusChange('blue', 'red')).toBe('red');
  });

  it('stays quiet going back or standing still', () => {
    expect(cueForStatusChange('red', 'blue')).toBeNull();
    expect(cueForStatusChange('yellow', 'green')).toBeNull();
    expect(cueForStatusChange('green', 'green')).toBeNull();
  });

  it('gives one, two and three notes', () => {
    expect(CUE_PATTERNS.green).toHaveLength(1);
    expect(CUE_PATTERNS.yellow).toHaveLength(2);
    expect(CUE_PATTERNS.red).toHaveLength(3);
  });
});

describe('shouldPlayBreakMusic', () => {
  const base = { enabled: true, isRunning: true, role: BREAK_ROLE, status: 'green' };

  it('plays while a break counts down', () => {
    expect(shouldPlayBreakMusic(base)).toBe(true);
    expect(shouldPlayBreakMusic({ ...base, status: 'blue' })).toBe(true);
  });

  it('stops at 00:00, on pause, for a speech, or when turned off', () => {
    expect(shouldPlayBreakMusic({ ...base, status: 'red' })).toBe(false);
    expect(shouldPlayBreakMusic({ ...base, isRunning: false })).toBe(false);
    expect(shouldPlayBreakMusic({ ...base, role: 'Standard Speech' })).toBe(false);
    expect(shouldPlayBreakMusic({ ...base, enabled: false })).toBe(false);
  });
});

describe('music box loop', () => {
  it('converts note names', () => {
    expect(noteToFrequency('A4')).toBe(440);
    expect(noteToFrequency('A5')).toBe(880);
    expect(noteToFrequency('C4')).toBeCloseTo(261.63, 2);
    expect(noteToFrequency('F#4')).toBeCloseTo(369.99, 2);
  });

  it('has both parts exactly one loop long', () => {
    const length = (part) => part.at(-1).beat + part.at(-1).beats;
    expect(length(MUSIC_BOX_LOOP.melody)).toBe(MUSIC_BOX_LOOP.lengthBeats);
    expect(length(MUSIC_BOX_LOOP.bass)).toBe(MUSIC_BOX_LOOP.lengthBeats);
  });
});

describe('sound engine', () => {
  afterEach(() => vi.useRealTimers());

  it('plays one rising note per step of the cue', () => {
    const ctx = fakeAudioContext();
    const engine = createSoundEngine({ createContext: () => ctx });
    expect(engine.playCue('yellow', 0.5)).toBe(true);
    // Each note is a fundamental plus a quiet octave above.
    expect(frequencies(ctx)).toEqual([659.25, 1318.5, 783.99, 1567.98]);
  });

  it('is silent at volume 0 and without Web Audio', () => {
    const ctx = fakeAudioContext();
    expect(createSoundEngine({ createContext: () => ctx }).playCue('red', 0)).toBe(false);
    expect(ctx.oscillators).toHaveLength(0);
    expect(createSoundEngine({ createContext: () => null }).playCue('red', 1)).toBe(false);
  });

  it('resumes a suspended context', () => {
    const ctx = { ...fakeAudioContext(), state: 'suspended' };
    createSoundEngine({ createContext: () => ctx }).unlock();
    expect(ctx.resume).toHaveBeenCalled();
  });

  it('creates the context once', () => {
    const createContext = vi.fn(fakeAudioContext);
    const engine = createSoundEngine({ createContext });
    engine.playCue('green', 1);
    engine.playCue('red', 1);
    expect(createContext).toHaveBeenCalledTimes(1);
  });

  it('schedules the music box ahead and keeps going until stopped', () => {
    vi.useFakeTimers();
    const ctx = fakeAudioContext();
    const engine = createSoundEngine({ createContext: () => ctx });
    engine.startMusic('music-box', 0.5);
    const first = ctx.oscillators.length;
    expect(first).toBeGreaterThan(0);
    expect(engine.isMusicPlaying()).toBe(true);

    // Run well past one loop: notes keep coming, the loop wraps.
    const loopSeconds = MUSIC_BOX_LOOP.lengthBeats * MUSIC_BOX_LOOP.beatSeconds;
    for (let t = 0; t < loopSeconds * 1.5; t += 0.1) {
      ctx.currentTime = t;
      vi.advanceTimersByTime(100);
    }
    const notesPerLoop = MUSIC_BOX_LOOP.melody.length + MUSIC_BOX_LOOP.bass.length;
    expect(ctx.oscillators.length).toBeGreaterThan(notesPerLoop);

    engine.stopMusic();
    expect(engine.isMusicPlaying()).toBe(false);
    const after = ctx.oscillators.length;
    ctx.currentTime += 5;
    vi.advanceTimersByTime(5000);
    expect(ctx.oscillators.length).toBe(after);
  });

  it('does not restart a track that is already playing', () => {
    vi.useFakeTimers();
    const ctx = fakeAudioContext();
    const engine = createSoundEngine({ createContext: () => ctx });
    engine.startMusic('music-box', 0.5);
    const count = ctx.oscillators.length;
    engine.startMusic('music-box', 0.5);
    expect(ctx.oscillators.length).toBe(count);
    engine.stopMusic();
  });
});
