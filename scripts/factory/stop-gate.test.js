import { describe, it, expect } from 'vitest';
import { decide, specsHit } from './stop-gate.mjs';

const specs = [
  { id: 'agenda-import', fm: { covers: ['packages/shared/simpleFormatParser.js', 'apps/zoom-app/src/components/AgendaTab.jsx'] } },
  { id: 'timer-core', fm: { covers: ['apps/zoom-app/src/context/'] } },
];
const hits = specsHit(specs, ['packages/shared/simpleFormatParser.js', 'README.md']);
const base = { branch: 'factory/90-import-role', env: {}, stopHookActive: false, hits, changedAt: 1000 };

describe('specsHit', () => {
  it('matches files and directory entries', () => {
    expect(specsHit(specs, ['apps/zoom-app/src/context/TimerContext.jsx'])).toEqual([
      { id: 'timer-core', files: ['apps/zoom-app/src/context/TimerContext.jsx'] },
    ]);
  });
  it('ignores files no spec covers and prefix look-alikes', () => {
    expect(specsHit(specs, ['README.md', 'apps/zoom-app/src/contextual.js'])).toEqual([]);
  });
});

describe('decide', () => {
  it('blocks a factory branch with no run since the change', () => {
    const d = decide({ ...base, runs: [] });
    expect(d.block).toBe(true);
    expect(d.reason).toContain('agenda-import (packages/shared/simpleFormatParser.js)');
    expect(d.reason).toContain('needs:zoom-test');
  });
  it('blocks when the only run is older than the change', () => {
    expect(decide({ ...base, runs: [{ mtime: 900, text: 'agenda-import' }] }).block).toBe(true);
  });
  it('blocks when a newer run does not name the spec', () => {
    expect(decide({ ...base, runs: [{ mtime: 1100, text: 'timer-core only' }] }).block).toBe(true);
  });
  it('passes when a newer run names every hit spec', () => {
    expect(decide({ ...base, runs: [{ mtime: 1100, text: '# Run: agenda-import on dev' }] }).block).toBe(false);
  });
  it('passes when nothing covered changed', () => {
    expect(decide({ ...base, hits: [], runs: [] }).block).toBe(false);
  });
  it.each([
    ['another branch', { branch: 'feat/club-card-sets' }],
    ['CI', { env: { CI: 'true' } }],
    ['a headless station', { env: { FACTORY_STATION: 'implement' } }],
    ['a stop right after a block', { stopHookActive: true }],
  ])('passes on %s', (_, over) => {
    expect(decide({ ...base, runs: [], ...over }).block).toBe(false);
  });
});
