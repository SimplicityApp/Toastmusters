/**
 * Timer sounds (Pro): a soft chime when the card changes, and music during a
 * break.
 *
 * Everything plays on the timer's own computer. No Zoom Apps API puts sound
 * into the meeting, so the speaker hears a chime only when the timer shares
 * their computer's sound, or when the speaker is in the same room. The
 * settings modal says so.
 *
 * The chime is synthesized with Web Audio rather than shipped as a file, so it
 * costs nothing to load and can never be missing. Break music is either a
 * synthesized loop or a licensed audio file under public/music/.
 */

import { BREAK_ROLE } from './timingRules.js';

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

// Not routed through storage.js's persist(): these are per-device (the sound
// comes out of this machine's speakers) and must not follow the user to
// another computer through profile sync.
export const SOUND_SETTINGS_KEY = 'toastmaster_sound_settings';

/**
 * Break music. A `synth` track is played by the engine below; a `file` track
 * is an audio file under the app's public/music/ folder. Only add a file whose
 * licence allows commercial use, and note the licence beside it.
 */
export const BREAK_TRACKS = Object.freeze([
  Object.freeze({ id: 'music-box', label: 'Music box', kind: 'synth' }),
]);

export const DEFAULT_BREAK_TRACK_ID = BREAK_TRACKS[0].id;

// Off by default: nothing should start beeping at someone who did not ask.
export const DEFAULT_SOUND_SETTINGS = Object.freeze({
  cues: false,
  music: false,
  track: DEFAULT_BREAK_TRACK_ID,
  volume: 0.7,
});

export function normalizeSoundSettings(value) {
  if (!value || typeof value !== 'object') return DEFAULT_SOUND_SETTINGS;
  const volume = Number(value.volume);
  return Object.freeze({
    cues: value.cues === true,
    music: value.music === true,
    // A track that was removed falls back to the default rather than silence.
    track: BREAK_TRACKS.some((t) => t.id === value.track) ? value.track : DEFAULT_BREAK_TRACK_ID,
    volume: Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : DEFAULT_SOUND_SETTINGS.volume,
  });
}

let currentSettings = null;
const settingsListeners = new Set();

/** The saved settings; the same object until they change (useSyncExternalStore). */
export function getSoundSettings() {
  if (currentSettings) return currentSettings;
  try {
    currentSettings = normalizeSoundSettings(JSON.parse(localStorage.getItem(SOUND_SETTINGS_KEY)));
  } catch {
    currentSettings = DEFAULT_SOUND_SETTINGS;
  }
  return currentSettings;
}

/** Merge a change into the settings, save it and notify subscribers. */
export function updateSoundSettings(patch) {
  currentSettings = normalizeSoundSettings({ ...getSoundSettings(), ...patch });
  try {
    localStorage.setItem(SOUND_SETTINGS_KEY, JSON.stringify(currentSettings));
  } catch {
    // Storage full or blocked: the setting still holds for this session.
  }
  for (const listener of settingsListeners) {
    try {
      listener(currentSettings);
    } catch {
      // One bad subscriber must not stop the others hearing about it.
    }
  }
  return currentSettings;
}

/**
 * @param {(settings: Object) => void} listener
 * @returns {() => void} unsubscribe
 */
export function subscribeSoundSettings(listener) {
  settingsListeners.add(listener);
  return () => settingsListeners.delete(listener);
}

/** Test seam. */
export function resetSoundSettingsForTests() {
  currentSettings = null;
  settingsListeners.clear();
}

// ---------------------------------------------------------------------------
// When to play
// ---------------------------------------------------------------------------

// One rising note per step, so a speaker can tell the card without looking:
// one note at green, two at yellow, three at red.
export const CUE_PATTERNS = Object.freeze({
  green: Object.freeze([659.25]),
  yellow: Object.freeze([659.25, 783.99]),
  red: Object.freeze([659.25, 783.99, 1046.5]),
});

const STATUS_ORDER = ['blue', 'green', 'yellow', 'red'];

/**
 * The cue for a card change, or null. Only a step forward chimes: a reset back
 * to blue, or rules edited so the card moves back, is not news to a speaker.
 *
 * @param {string} previous
 * @param {string} next
 * @returns {'green'|'yellow'|'red'|null}
 */
export function cueForStatusChange(previous, next) {
  if (!(next in CUE_PATTERNS)) return null;
  return STATUS_ORDER.indexOf(next) > STATUS_ORDER.indexOf(previous) ? next : null;
}

/**
 * Break music plays while a break is counting down, and stops when it reaches
 * 00:00 (red) so the silence itself says the break is over.
 */
export function shouldPlayBreakMusic({ enabled, isRunning, role, status }) {
  return Boolean(enabled && isRunning && role === BREAK_ROLE && status !== 'red');
}

// ---------------------------------------------------------------------------
// The music box: a short cheerful loop in C major
// ---------------------------------------------------------------------------

const NOTE_OFFSETS = { C: -9, D: -7, E: -5, F: -4, G: -2, A: 0, B: 2 };

/** 'A4' → 440. Sharps as 'F#4'. */
export function noteToFrequency(name) {
  const match = /^([A-G])(#?)(\d)$/.exec(name);
  if (!match) throw new Error(`Bad note: ${name}`);
  const semitones = NOTE_OFFSETS[match[1]] + (match[2] ? 1 : 0) + (Number(match[3]) - 4) * 12;
  return 440 * 2 ** (semitones / 12);
}

const MUSIC_BOX_BPM = 112;

// [note, beats]. Eight bars of four beats.
const MUSIC_BOX_MELODY = [
  ['E5', 0.5], ['G5', 0.5], ['C6', 1], ['B5', 0.5], ['A5', 0.5], ['G5', 1],
  ['A5', 0.5], ['B5', 0.5], ['C6', 0.5], ['A5', 0.5], ['G5', 2],
  ['F5', 0.5], ['A5', 0.5], ['G5', 0.5], ['F5', 0.5], ['E5', 1], ['C5', 1],
  ['D5', 0.5], ['E5', 0.5], ['F5', 0.5], ['D5', 0.5], ['G5', 2],
  ['E5', 0.5], ['G5', 0.5], ['C6', 1], ['B5', 0.5], ['A5', 0.5], ['G5', 1],
  ['A5', 0.5], ['B5', 0.5], ['C6', 0.5], ['D6', 0.5], ['E6', 2],
  ['D6', 0.5], ['C6', 0.5], ['B5', 0.5], ['A5', 0.5], ['G5', 0.5], ['F5', 0.5], ['E5', 0.5], ['D5', 0.5],
  ['C5', 1], ['G5', 1], ['C6', 2],
];

// Two half-note bass notes per bar.
const MUSIC_BOX_BASS = [
  'C3', 'G3', 'F3', 'C3', 'F3', 'C3', 'G3', 'G2',
  'C3', 'G3', 'F3', 'A3', 'G3', 'G2', 'C3', 'C3',
].map((note) => [note, 2]);

/** Flatten a part into {frequency, beat, beats} events from beat 0. */
function toEvents(part) {
  let beat = 0;
  return part.map(([note, beats]) => {
    const event = { frequency: noteToFrequency(note), beat, beats };
    beat += beats;
    return event;
  });
}

export const MUSIC_BOX_LOOP = Object.freeze({
  beatSeconds: 60 / MUSIC_BOX_BPM,
  lengthBeats: 32,
  melody: toEvents(MUSIC_BOX_MELODY),
  bass: toEvents(MUSIC_BOX_BASS),
});

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

// Loudness at volume 1. Kept well under full scale: a chime should be heard,
// not jump out of the speakers.
const CUE_LEVEL = 0.22;
const MUSIC_LEVEL = 0.35;
const SCHEDULE_AHEAD_SECONDS = 0.4;
const SCHEDULER_INTERVAL_MS = 100;
const FADE_SECONDS = 0.4;

function defaultCreateContext() {
  const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
  return Ctor ? new Ctor() : null;
}

/** One enveloped note: quick attack, exponential decay. */
function playTone(ctx, destination, { frequency, start, duration, peak, type = 'sine' }) {
  if (!(peak > 0)) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(frequency, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(gain);
  gain.connect(destination);
  osc.start(start);
  osc.stop(start + duration + 0.05);
}

/**
 * Plays cues and break music. Creates its AudioContext on first use, which
 * should follow a click (Start) so the browser lets it make sound.
 *
 * @param {Object} [options]
 * @param {() => AudioContext|null} [options.createContext]
 * @param {(url: string) => HTMLAudioElement} [options.createAudio]
 * @param {(file: string) => string} [options.resolveTrackUrl] - a file track's URL
 */
export function createSoundEngine({
  createContext = defaultCreateContext,
  createAudio = (url) => new Audio(url),
  resolveTrackUrl = (file) => file,
} = {}) {
  let ctx;
  // { trackId, stop(), setVolume(v) } for whatever is playing now.
  let music = null;

  function context() {
    if (ctx === undefined) {
      try {
        ctx = createContext();
      } catch {
        ctx = null;
      }
    }
    if (ctx && ctx.state === 'suspended') ctx.resume?.().catch(() => {});
    return ctx;
  }

  function startSynth(ac, volume) {
    const loop = MUSIC_BOX_LOOP;
    const out = ac.createGain();
    out.gain.setValueAtTime(volume * MUSIC_LEVEL, ac.currentTime);
    out.connect(ac.destination);
    const loopSeconds = loop.lengthBeats * loop.beatSeconds;
    let loopStart = ac.currentTime + 0.05;
    // The next event to schedule in each part, carried across ticks.
    const cursors = { melody: 0, bass: 0 };

    function schedulePart(part, key, horizon, voice) {
      while (true) {
        const event = loop[part][cursors[key]];
        const at = loopStart + event.beat * loop.beatSeconds;
        if (at > horizon) return false;
        playTone(ac, out, {
          frequency: event.frequency,
          start: at,
          duration: Math.max(0.25, event.beats * loop.beatSeconds * 0.9),
          ...voice,
        });
        cursors[key] += 1;
        if (cursors[key] === loop[part].length) return true;
      }
    }

    function tick() {
      const horizon = ac.currentTime + SCHEDULE_AHEAD_SECONDS;
      // Both parts are exactly one loop long; once both have run out, the
      // next pass starts one loop later.
      const melodyDone = cursors.melody === loop.melody.length || schedulePart('melody', 'melody', horizon, { peak: 0.5, type: 'triangle' });
      const bassDone = cursors.bass === loop.bass.length || schedulePart('bass', 'bass', horizon, { peak: 0.35, type: 'sine' });
      if (melodyDone && bassDone) {
        loopStart += loopSeconds;
        cursors.melody = 0;
        cursors.bass = 0;
      }
    }

    tick();
    const timer = setInterval(tick, SCHEDULER_INTERVAL_MS);
    return {
      stop() {
        clearInterval(timer);
        const now = ac.currentTime;
        out.gain.cancelScheduledValues(now);
        out.gain.setValueAtTime(out.gain.value, now);
        out.gain.linearRampToValueAtTime(0, now + FADE_SECONDS);
        setTimeout(() => out.disconnect(), FADE_SECONDS * 1000 + 100);
      },
      setVolume(v) {
        out.gain.setValueAtTime(v * MUSIC_LEVEL, ac.currentTime);
      },
    };
  }

  function startFile(track, volume) {
    const audio = createAudio(resolveTrackUrl(track.file));
    audio.loop = true;
    audio.volume = volume;
    const playing = audio.play();
    if (playing?.catch) playing.catch(() => {});
    return {
      stop() {
        audio.pause();
      },
      setVolume(v) {
        audio.volume = v;
      },
    };
  }

  return {
    /** Create or resume the AudioContext; call from a click handler. */
    unlock() {
      context();
    },

    /** @param {'green'|'yellow'|'red'} color */
    playCue(color, volume) {
      const notes = CUE_PATTERNS[color];
      const ac = notes && volume > 0 ? context() : null;
      if (!ac) return false;
      const start = ac.currentTime + 0.02;
      notes.forEach((frequency, i) => {
        const at = start + i * 0.22;
        playTone(ac, ac.destination, { frequency, start: at, duration: 0.9, peak: volume * CUE_LEVEL });
        // A quiet octave above gives it a bell's shimmer rather than a beep.
        playTone(ac, ac.destination, { frequency: frequency * 2, start: at, duration: 0.5, peak: volume * CUE_LEVEL * 0.2 });
      });
      return true;
    },

    startMusic(trackId, volume) {
      if (music?.trackId === trackId) return true;
      this.stopMusic();
      const track = BREAK_TRACKS.find((t) => t.id === trackId) ?? BREAK_TRACKS[0];
      if (track.kind === 'file') {
        music = { trackId, ...startFile(track, volume) };
        return true;
      }
      const ac = context();
      if (!ac) return false;
      music = { trackId, ...startSynth(ac, volume) };
      return true;
    },

    stopMusic() {
      music?.stop();
      music = null;
    },

    setMusicVolume(volume) {
      music?.setVolume(volume);
    },

    isMusicPlaying() {
      return music !== null;
    },
  };
}
