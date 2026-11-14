import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  CLUB_PROMPT,
  REVIEW_PROMPT,
  PRO_LAUNCH_PROMPT,
  DEFAULT_PROMPTS,
  PRO_LAUNCH_BADGE_DAYS,
  GLOBAL_COOLDOWN_DAYS,
  PROMPT_ORDER,
  PROMPT_RULES,
  isProLaunchBadgeDue,
  forcePrompt,
  isPromptDebugMode,
  isPromptDue,
  loadPromptState,
  markPromptAnswered,
  markPromptDeclined,
  markPromptShown,
  recordSpeechFinished,
  resetPromptState,
  savePromptState,
  selectDuePrompt,
  subscribeToForcedPrompt,
  subscribeToPromptState,
} from '../promptScheduler.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 6, 30);

// Production cadence, pinned so these assertions hold whatever
// VITE_ENABLE_DEBUG_PANEL happens to be set to in the shell running the tests.
const STRICT = { ignoreTimeGates: false };

function finishSpeeches(count) {
  for (let i = 0; i < count; i += 1) recordSpeechFinished();
}

beforeEach(() => {
  localStorage.clear();
});

describe('recordSpeechFinished', () => {
  it('accumulates finished speeches across reloads', () => {
    finishSpeeches(3);
    expect(loadPromptState().speechesFinished).toBe(3);

    // A fresh load reads the same localStorage payload.
    expect(loadPromptState().speechesFinished).toBe(3);
  });

  it('notifies subscribers with the new state', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToPromptState(listener);

    recordSpeechFinished();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0].speechesFinished).toBe(1);

    unsubscribe();
    recordSpeechFinished();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('first ask', () => {
  it('stays quiet below the club threshold', () => {
    finishSpeeches(PROMPT_RULES[CLUB_PROMPT].firstAskAfterSpeeches - 1);
    expect(selectDuePrompt(loadPromptState(), NOW)).toBeNull();
  });

  it('asks the club question once its threshold is reached', () => {
    finishSpeeches(PROMPT_RULES[CLUB_PROMPT].firstAskAfterSpeeches);
    expect(selectDuePrompt(loadPromptState(), NOW)).toBe(CLUB_PROMPT);
  });

  it('prefers the club question when both prompts are due', () => {
    finishSpeeches(PROMPT_RULES[REVIEW_PROMPT].firstAskAfterSpeeches);
    const state = loadPromptState();

    expect(isPromptDue(CLUB_PROMPT, state, NOW)).toBe(true);
    expect(isPromptDue(REVIEW_PROMPT, state, NOW)).toBe(true);
    expect(selectDuePrompt(state, NOW)).toBe(CLUB_PROMPT);
  });

  it('skips prompts this app does not support', () => {
    finishSpeeches(PROMPT_RULES[REVIEW_PROMPT].firstAskAfterSpeeches);
    expect(selectDuePrompt(loadPromptState(), NOW, [REVIEW_PROMPT])).toBe(REVIEW_PROMPT);
  });
});

describe('global cooldown', () => {
  it('holds the second prompt back until the cooldown expires', () => {
    finishSpeeches(PROMPT_RULES[REVIEW_PROMPT].firstAskAfterSpeeches);
    markPromptShown(CLUB_PROMPT, NOW);
    markPromptAnswered(CLUB_PROMPT);

    // Review is otherwise due, but the club ask just happened.
    expect(selectDuePrompt(loadPromptState(), NOW + DAY_MS, DEFAULT_PROMPTS, STRICT)).toBeNull();
    expect(
      selectDuePrompt(loadPromptState(), NOW + GLOBAL_COOLDOWN_DAYS * DAY_MS, DEFAULT_PROMPTS, STRICT)
    ).toBe(REVIEW_PROMPT);
  });
});

describe('re-asking a dismissed prompt', () => {
  const rules = PROMPT_RULES[CLUB_PROMPT];

  beforeEach(() => {
    finishSpeeches(rules.firstAskAfterSpeeches);
    markPromptShown(CLUB_PROMPT, NOW);
  });

  it('requires both more speeches and more elapsed days', () => {
    const laterEnough = NOW + rules.daysBetweenAsks * DAY_MS;

    // Enough time, not enough usage.
    expect(isPromptDue(CLUB_PROMPT, loadPromptState(), laterEnough, STRICT)).toBe(false);

    finishSpeeches(rules.speechesBetweenAsks);

    // Enough usage, not enough time.
    expect(isPromptDue(CLUB_PROMPT, loadPromptState(), NOW + DAY_MS, STRICT)).toBe(false);

    // Both satisfied.
    expect(isPromptDue(CLUB_PROMPT, loadPromptState(), laterEnough, STRICT)).toBe(true);
  });

  it('gives up after maxAsks', () => {
    let when = NOW;
    for (let ask = 1; ask < rules.maxAsks; ask += 1) {
      finishSpeeches(rules.speechesBetweenAsks);
      when += rules.daysBetweenAsks * DAY_MS;
      expect(isPromptDue(CLUB_PROMPT, loadPromptState(), when, STRICT)).toBe(true);
      markPromptShown(CLUB_PROMPT, when);
    }

    finishSpeeches(rules.speechesBetweenAsks * 10);
    when += rules.daysBetweenAsks * DAY_MS * 10;
    expect(loadPromptState().prompts[CLUB_PROMPT].asks).toBe(rules.maxAsks);
    expect(isPromptDue(CLUB_PROMPT, loadPromptState(), when, STRICT)).toBe(false);
  });
});

describe('terminal resolutions', () => {
  const far = NOW + 365 * DAY_MS;

  it.each([
    ['answered', markPromptAnswered],
    ['declined', markPromptDeclined],
  ])('never asks again once %s', (_label, resolveFn) => {
    finishSpeeches(PROMPT_RULES[CLUB_PROMPT].firstAskAfterSpeeches);
    markPromptShown(CLUB_PROMPT, NOW);
    resolveFn(CLUB_PROMPT);

    finishSpeeches(100);
    expect(isPromptDue(CLUB_PROMPT, loadPromptState(), far, STRICT)).toBe(false);
  });
});

describe('dev mode (VITE_ENABLE_DEBUG_PANEL=true)', () => {
  it('reads the flag from the environment', () => {
    vi.stubEnv('VITE_ENABLE_DEBUG_PANEL', 'true');
    expect(isPromptDebugMode()).toBe(true);

    // Only the exact string 'true' counts — the panel's own default is "not false".
    vi.stubEnv('VITE_ENABLE_DEBUG_PANEL', 'false');
    expect(isPromptDebugMode()).toBe(false);

    vi.unstubAllEnvs();
  });

  it('re-asks a dismissed prompt without waiting out the days', () => {
    const rules = PROMPT_RULES[CLUB_PROMPT];
    finishSpeeches(rules.firstAskAfterSpeeches);
    markPromptShown(CLUB_PROMPT, NOW);
    finishSpeeches(rules.speechesBetweenAsks);

    const soon = NOW + 60 * 1000;
    expect(isPromptDue(CLUB_PROMPT, loadPromptState(), soon, STRICT)).toBe(false);
    expect(isPromptDue(CLUB_PROMPT, loadPromptState(), soon, { ignoreTimeGates: true })).toBe(true);
  });

  it('lets the second prompt through the global cooldown', () => {
    finishSpeeches(PROMPT_RULES[REVIEW_PROMPT].firstAskAfterSpeeches);
    markPromptShown(CLUB_PROMPT, NOW);
    markPromptAnswered(CLUB_PROMPT);

    const soon = NOW + 60 * 1000;
    expect(selectDuePrompt(loadPromptState(), soon, DEFAULT_PROMPTS, STRICT)).toBeNull();
    expect(selectDuePrompt(loadPromptState(), soon, DEFAULT_PROMPTS, { ignoreTimeGates: true })).toBe(
      REVIEW_PROMPT
    );
  });

  it('still respects answered, declined, maxAsks and the usage thresholds', () => {
    const loose = { ignoreTimeGates: true };
    const rules = PROMPT_RULES[CLUB_PROMPT];

    // Usage threshold is not a time gate.
    finishSpeeches(rules.firstAskAfterSpeeches - 1);
    expect(isPromptDue(CLUB_PROMPT, loadPromptState(), NOW, loose)).toBe(false);

    finishSpeeches(1);
    expect(isPromptDue(CLUB_PROMPT, loadPromptState(), NOW, loose)).toBe(true);

    // The ask cap still ends it.
    for (let ask = 0; ask < rules.maxAsks; ask += 1) {
      markPromptShown(CLUB_PROMPT, NOW);
      finishSpeeches(rules.speechesBetweenAsks);
    }
    expect(isPromptDue(CLUB_PROMPT, loadPromptState(), NOW, loose)).toBe(false);

    // And declining is still permanent.
    localStorage.clear();
    finishSpeeches(rules.firstAskAfterSpeeches);
    markPromptDeclined(CLUB_PROMPT);
    expect(isPromptDue(CLUB_PROMPT, loadPromptState(), NOW, loose)).toBe(false);
  });
});

describe('stored state', () => {
  it('survives a partial or corrupt payload', () => {
    localStorage.setItem('toastmaster_prompts', 'not json');
    expect(loadPromptState().speechesFinished).toBe(0);

    savePromptState({ speechesFinished: 12 });
    const state = loadPromptState();
    expect(state.speechesFinished).toBe(12);
    expect(state.prompts[CLUB_PROMPT]).toEqual({
      asks: 0,
      lastAskAt: 0,
      lastAskAtSpeeches: 0,
      resolution: null,
    });
    expect(isPromptDue(CLUB_PROMPT, state, NOW)).toBe(true);
  });

  it('ignores an unknown resolution value', () => {
    savePromptState({
      speechesFinished: 50,
      prompts: { [CLUB_PROMPT]: { resolution: 'maybe-later' } },
    });
    expect(isPromptDue(CLUB_PROMPT, loadPromptState(), NOW)).toBe(true);
  });

  it('resetPromptState clears history and notifies', () => {
    finishSpeeches(5);
    const listener = vi.fn();
    const unsubscribe = subscribeToPromptState(listener);

    resetPromptState();

    expect(loadPromptState().speechesFinished).toBe(0);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ speechesFinished: 0 }));
    unsubscribe();
  });

  it.each([
    ['markPromptShown', () => markPromptShown(CLUB_PROMPT, NOW)],
    ['markPromptAnswered', () => markPromptAnswered(CLUB_PROMPT)],
  ])('%s notifies subscribers, so a debug readout stays live', (_label, mutate) => {
    const listener = vi.fn();
    const unsubscribe = subscribeToPromptState(listener);

    mutate();

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ prompts: expect.any(Object) })
    );
    unsubscribe();
  });
});

describe('forcePrompt (debug panel)', () => {
  it('hands the prompt key to subscribers', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToForcedPrompt(listener);

    forcePrompt(REVIEW_PROMPT);

    expect(listener).toHaveBeenCalledWith(REVIEW_PROMPT);
    unsubscribe();
  });

  // Forcing a prompt is a preview, not an ask — otherwise testing the copy would
  // burn one of the three asks the cadence allows.
  it('records nothing, so the cadence is untouched', () => {
    finishSpeeches(3);
    forcePrompt(CLUB_PROMPT);

    const state = loadPromptState();
    expect(state.prompts[CLUB_PROMPT].asks).toBe(0);
    expect(state.lastPromptAt).toBe(0);
    expect(isPromptDue(CLUB_PROMPT, state, NOW, STRICT)).toBe(true);
  });

  it('stops calling a listener once unsubscribed', () => {
    const listener = vi.fn();
    subscribeToForcedPrompt(listener)();

    forcePrompt(CLUB_PROMPT);

    expect(listener).not.toHaveBeenCalled();
  });
});

describe('the Pro launch announcement', () => {
  const ALL = PROMPT_ORDER;

  it('is never picked unless the app enables it', () => {
    finishSpeeches(PROMPT_RULES[REVIEW_PROMPT].firstAskAfterSpeeches);
    const state = loadPromptState();

    expect(isPromptDue(PRO_LAUNCH_PROMPT, state, NOW)).toBe(true);
    expect(DEFAULT_PROMPTS).not.toContain(PRO_LAUNCH_PROMPT);
    expect(selectDuePrompt(state, NOW)).toBe(CLUB_PROMPT);
  });

  it('is due after the first finished speech, and goes ahead of the others', () => {
    expect(selectDuePrompt(loadPromptState(), NOW, ALL)).toBeNull();
    finishSpeeches(1);
    expect(selectDuePrompt(loadPromptState(), NOW, ALL)).toBe(PRO_LAUNCH_PROMPT);

    finishSpeeches(PROMPT_RULES[REVIEW_PROMPT].firstAskAfterSpeeches);
    expect(selectDuePrompt(loadPromptState(), NOW, ALL)).toBe(PRO_LAUNCH_PROMPT);
  });

  it('is shown once: a dismissal retires it, however much the timer is used after', () => {
    finishSpeeches(1);
    markPromptShown(PRO_LAUNCH_PROMPT, NOW);

    finishSpeeches(100);
    const muchLater = NOW + 365 * DAY_MS;
    expect(isPromptDue(PRO_LAUNCH_PROMPT, loadPromptState(), muchLater, STRICT)).toBe(false);
    expect(isPromptDue(PRO_LAUNCH_PROMPT, loadPromptState(), muchLater, { ignoreTimeGates: true })).toBe(false);
  });

  it('holds the club question back for the global cooldown after it shows', () => {
    finishSpeeches(PROMPT_RULES[CLUB_PROMPT].firstAskAfterSpeeches);
    markPromptShown(PRO_LAUNCH_PROMPT, NOW);

    expect(selectDuePrompt(loadPromptState(), NOW + DAY_MS, ALL, STRICT)).toBeNull();
    expect(
      selectDuePrompt(loadPromptState(), NOW + GLOBAL_COOLDOWN_DAYS * DAY_MS, ALL, STRICT)
    ).toBe(CLUB_PROMPT);
  });

  it('is not due once answered (any Upgrade dialog marks it)', () => {
    finishSpeeches(1);
    markPromptAnswered(PRO_LAUNCH_PROMPT);
    expect(selectDuePrompt(loadPromptState(), NOW, ALL)).toBeNull();
  });

  it('keeps an old browser\'s stored prompts and adds the new record', () => {
    savePromptState({
      speechesFinished: 40,
      lastPromptAt: NOW - 30 * DAY_MS,
      prompts: { [CLUB_PROMPT]: { asks: 1, resolution: 'answered' } },
    });
    const state = loadPromptState();
    expect(state.prompts[CLUB_PROMPT].resolution).toBe('answered');
    expect(state.prompts[PRO_LAUNCH_PROMPT]).toEqual({
      asks: 0,
      lastAskAt: 0,
      lastAskAtSpeeches: 0,
      resolution: null,
    });
    expect(selectDuePrompt(state, NOW, ALL, STRICT)).toBe(PRO_LAUNCH_PROMPT);
  });
});

describe('isProLaunchBadgeDue', () => {
  it('shows before the announcement has had its chance', () => {
    expect(isProLaunchBadgeDue(loadPromptState(), NOW)).toBe(true);
  });

  it('stays for the badge window after the announcement was dismissed, then goes', () => {
    markPromptShown(PRO_LAUNCH_PROMPT, NOW);
    const state = loadPromptState();
    expect(isProLaunchBadgeDue(state, NOW + (PRO_LAUNCH_BADGE_DAYS - 1) * DAY_MS)).toBe(true);
    expect(isProLaunchBadgeDue(state, NOW + PRO_LAUNCH_BADGE_DAYS * DAY_MS)).toBe(false);
  });

  it('goes as soon as the user has looked at Pro', () => {
    markPromptAnswered(PRO_LAUNCH_PROMPT);
    expect(isProLaunchBadgeDue(loadPromptState(), NOW)).toBe(false);
  });

  it('is false for a missing or malformed state', () => {
    expect(isProLaunchBadgeDue(null, NOW)).toBe(false);
    expect(isProLaunchBadgeDue({ prompts: {} }, NOW)).toBe(false);
  });
});
