import { describe, it, expect } from 'vitest';
import { deriveBreakRules } from '@toastmaster-timer/shared';
import { cardStatusLine, formatThreshold, rulesLine, thresholdsLine } from './format';

const ICE_BREAKER = { green: 240, yellow: 300, red: 360, graceAfterRed: 30 };

describe('formatThreshold', () => {
  it('says thresholds the short way', () => {
    expect(formatThreshold(240)).toBe('4:00');
    expect(formatThreshold(30)).toBe('0:30');
    expect(formatThreshold(725)).toBe('12:05');
    expect(formatThreshold(-5)).toBe('0:00');
  });
});

describe('rulesLine / thresholdsLine', () => {
  it('reads the three colours', () => {
    expect(rulesLine(ICE_BREAKER)).toBe('Green 4:00 · Yellow 5:00 · Red 6:00');
    expect(thresholdsLine(ICE_BREAKER)).toBe('4:00 · 5:00 · 6:00');
    expect(rulesLine(null)).toBe('');
  });
});

describe('cardStatusLine', () => {
  const speech = (over) => cardStatusLine({ status: 'blue', rules: ICE_BREAKER, isRunning: false, elapsedTime: 0, ...over });

  it('says when the first colour comes before anything starts', () => {
    expect(speech()).toBe('Ready · green at 4:00');
  });

  it('names the colour on and the next one while running', () => {
    expect(speech({ isRunning: true, elapsedTime: 72 })).toBe('Blue · green at 4:00');
    expect(speech({ status: 'green', isRunning: true, elapsedTime: 267 })).toBe('Green · yellow at 5:00');
    expect(speech({ status: 'yellow', isRunning: true, elapsedTime: 318 })).toBe('Yellow · red at 6:00');
    expect(speech({ status: 'red', isRunning: true, elapsedTime: 369 })).toBe('Red phase');
  });

  it('says paused, with what is next', () => {
    expect(speech({ status: 'yellow', elapsedTime: 331 })).toBe('Paused · red at 6:00');
    expect(speech({ status: 'red', elapsedTime: 400 })).toBe('Paused · red');
  });

  it('tells a video-off organizer why Start will not work, before anything starts', () => {
    expect(speech({ videoOff: true })).toBe('Start works once your video is on');
    expect(speech({ videoOff: true, isRunning: true, elapsedTime: 10 })).toBe('Blue · green at 4:00');
  });

  it('says a preview is a preview', () => {
    expect(speech({ previewColor: 'green' })).toBe('Previewing green on your video');
  });

  it('counts a break down', () => {
    const rules = deriveBreakRules(300);
    expect(cardStatusLine({ status: 'blue', rules, isRunning: false, elapsedTime: 0 })).toMatch(/^Counts down · green when \d\d:\d\d left$/);
    expect(cardStatusLine({ status: 'green', rules, isRunning: true, elapsedTime: 200 })).toMatch(/^Yellow when \d\d:\d\d left$/);
    expect(cardStatusLine({ status: 'green', rules, isRunning: false, elapsedTime: 200 })).toMatch(/^Paused · yellow when/);
  });

  it('says nothing without rules', () => {
    expect(cardStatusLine({ status: 'blue', rules: null, isRunning: false, elapsedTime: 0 })).toBe('');
  });
});
