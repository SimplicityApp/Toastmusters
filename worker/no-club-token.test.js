import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as auth from './auth.js';

/**
 * No device bindings are left anywhere (#167, AC-7), and the place counter the
 * cap depends on is actually deployed (AC-3).
 *
 * The club token, the `club-device:` rows and the `X-Club` header go together:
 * club Pro follows the Zoom account through its session, so nothing in the
 * Worker, the shared package or either app may still build, send or read them.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const ROOTS = ['worker', 'packages/shared', 'apps/zoom-app/src', 'apps/web/src', 'packages/ui'];
const SOURCE = /\.(m?js|jsx)$/;
const SKIP_DIR = new Set(['node_modules', '__tests__', 'dist', 'coverage']);

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIR.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (SOURCE.test(name) && !/\.test\.|\.spec\./.test(name) && !/fake|helpers/.test(name)) out.push(path);
  }
  return out;
}

const sources = () =>
  ROOTS.flatMap((root) => walk(join(repoRoot, root))).map((path) => ({
    file: relative(repoRoot, path),
    text: readFileSync(path, 'utf8'),
  }));

function offenders(pattern) {
  return sources()
    .filter(({ text }) => pattern.test(text))
    .map(({ file }) => file)
    .sort();
}

describe('no device bindings in the source (AC-7)', () => {
  it('names no club-device: record', () => {
    expect(offenders(/club-device:/)).toEqual([]);
  });

  it('sends and reads no X-Club header', () => {
    expect(offenders(/x-club/i)).toEqual([]);
  });

  // `clubToken` itself is allowed: the shared cache may still name it to drop
  // an entry saved before #167. Minting and verifying one is what must go.
  it('mints and verifies no club token', () => {
    expect(offenders(/mintClubToken|verifyClubToken|readClubHeader/)).toEqual([]);
  });

  it('keeps no per-device club id or club header helper', () => {
    expect(offenders(/clubDeviceId|clubHeaders|clubDeviceKey|handleDeviceRevoke/)).toEqual([]);
  });

  it('has deleted worker/club-token.js and readClub', () => {
    expect(existsSync(join(repoRoot, 'worker/club-token.js'))).toBe(false);
    expect(existsSync(join(repoRoot, 'worker/club-token.test.js'))).toBe(false);
    expect(offenders(/club-token\.js/)).toEqual([]);
    expect(auth.readClub).toBeUndefined();
  });

  it('says "No sign-in needed" and "This device is on Pro" nowhere', () => {
    expect(offenders(/No sign-in needed/)).toEqual([]);
    expect(offenders(/This device is on Pro/)).toEqual([]);
  });
});

/**
 * wrangler.jsonc as data. As in worker/flags.test.js: comments always sit on
 * their own line and the file holds URLs, so only whole-line `//` comments go.
 */
function readWranglerConfig() {
  const source = readFileSync(join(repoRoot, 'wrangler.jsonc'), 'utf8');
  return JSON.parse(source.replace(/^\s*\/\/.*$/gm, ''));
}

const placesBinding = (block) =>
  (block?.durable_objects?.bindings ?? []).find((b) => b.name === 'CLUB_PLACES');
const declaresClubPlaces = (migrations) =>
  (migrations ?? []).some((m) => (m.new_sqlite_classes ?? []).includes('ClubPlaces'));

describe('the ClubPlaces Durable Object is deployed (AC-3)', () => {
  const config = readWranglerConfig();

  // Bindings are not inherited by environments: both blocks need their own.
  it('is bound as CLUB_PLACES in production and in env.dev', () => {
    expect(placesBinding(config)).toMatchObject({ name: 'CLUB_PLACES', class_name: 'ClubPlaces' });
    expect(placesBinding(config.env?.dev)).toMatchObject({ name: 'CLUB_PLACES', class_name: 'ClubPlaces' });
  });

  it('has a SQLite migration creating ClubPlaces for both Workers', () => {
    expect(declaresClubPlaces(config.migrations)).toBe(true);
    expect(declaresClubPlaces(config.env?.dev?.migrations ?? config.migrations)).toBe(true);
  });

  it('is exported by the Worker entry point', async () => {
    const entry = await import('./index.js');
    expect(entry.ClubPlaces).toBeTypeOf('function');
  });
});
