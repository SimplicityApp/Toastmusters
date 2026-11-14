import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { refusal, oraclePath } from './oracle-guard.mjs';
import { check } from './check-oracle.mjs';

const oracle = { issue: 90, files: ['packages/shared/__tests__/simpleFormatParser.test.js'] };
const branch = 'factory/90-import-role';

describe('refusal (PreToolUse guard)', () => {
  it('refuses an oracle test and the oracle json', () => {
    expect(refusal({ branch, file: oracle.files[0], oracle })).toContain('oracle test for #90');
    expect(refusal({ branch, file: oraclePath(90), oracle })).toContain('oracle test for #90');
  });
  it('allows other files, the oracle station, other branches, and branches without an oracle', () => {
    expect(refusal({ branch, file: 'packages/shared/simpleFormatParser.js', oracle })).toBeNull();
    expect(refusal({ branch, station: 'oracle', file: oracle.files[0], oracle })).toBeNull();
    expect(refusal({ branch: 'feat/x', file: oracle.files[0], oracle })).toBeNull();
    expect(refusal({ branch, file: oracle.files[0], oracle: null })).toBeNull();
  });
});

describe('check (CI)', () => {
  let root;
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  const write = (path, text) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), text); };
  const commit = (msg) => { git('add', '-A'); git('commit', '-q', '-m', msg); };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'oracle-'));
    git('init', '-q', '-b', 'dev');
    git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
    write('src/a.js', 'a'); write('test/a.test.js', 'old'); commit('base');
    git('checkout', '-q', '-b', 'factory/90-x');
    write('test/a.test.js', 'oracle'); write('.factory/oracles/90.json', JSON.stringify({ issue: 90, files: ['test/a.test.js'] }));
    commit('oracle');
    return () => rmSync(root, { recursive: true, force: true });
  });

  it('passes when only the code changes after the oracle commit', () => {
    write('src/a.js', 'impl'); commit('implement');
    expect(check(root, 'dev')).toEqual({ checked: ['.factory/oracles/90.json'], problems: [] });
  });
  it('fails when an oracle test changes after the oracle commit', () => {
    write('test/a.test.js', 'weakened'); commit('implement');
    const { problems } = check(root, 'dev');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('test/a.test.js');
    expect(problems[0]).toContain('implement');
  });
  it('fails when the oracle json is edited to drop a file', () => {
    write('.factory/oracles/90.json', JSON.stringify({ issue: 90, files: [] })); commit('drop');
    expect(check(root, 'dev').problems[0]).toContain('.factory/oracles/90.json');
  });
  it('accepts a human re-recording the oracle', () => {
    write('test/a.test.js', 'fixed'); git('rm', '-q', '.factory/oracles/90.json'); commit('rm');
    write('.factory/oracles/90.json', JSON.stringify({ issue: 90, files: ['test/a.test.js'] })); commit('re-add');
    expect(check(root, 'dev').problems).toEqual([]);
  });
  it('checks nothing on a branch without an oracle', () => {
    git('checkout', '-q', 'dev');
    expect(check(root, 'dev')).toEqual({ checked: [], problems: [] });
  });
});
