#!/usr/bin/env node
// CI: for every .factory/oracles/<n>.json added since --base (default origin/dev), fail when a
// listed test, or the json itself, changed in a commit after the one that last added the json.
// A human who changes an oracle test on purpose removes the json in one commit and adds it
// back in the next, which moves the oracle commit forward.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const lines = (s) => s.split('\n').filter(Boolean);

export function check(root, base) {
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const added = lines(git(['diff', '--name-only', '--diff-filter=AM', `${base}...HEAD`, '--', '.factory/oracles/']))
    .filter((f) => f.endsWith('.json'));
  const problems = [];
  for (const json of added) {
    const { files = [] } = JSON.parse(readFileSync(join(root, json), 'utf8'));
    const oracleCommit = lines(git(['log', '--diff-filter=A', '--format=%H', `${base}..HEAD`, '--', json]))[0];
    if (!oracleCommit) { problems.push(`${json}: changed, but never added on this branch`); continue; }
    const later = lines(git(['log', '--format=%h %s', `${oracleCommit}..HEAD`, '--', json, ...files]));
    if (later.length) {
      const touched = lines(git(['diff', '--name-only', `${oracleCommit}..HEAD`, '--', json, ...files]));
      problems.push(`${json}: oracle files changed after the oracle commit ${oracleCommit.slice(0, 7)}:\n    ${touched.join('\n    ')}\n  in:\n    ${later.join('\n    ')}`);
    }
  }
  return { checked: added, problems };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--base');
  const base = i > 0 ? process.argv[i + 1] : 'origin/dev';
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const { checked, problems } = check(root, base);
  for (const p of problems) console.error(`✗ ${p}`);
  if (problems.length) process.exit(1);
  console.log(checked.length ? `✓ ${checked.length} oracle(s) untouched since their oracle commit` : '✓ no oracle on this branch');
}
