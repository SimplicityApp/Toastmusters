#!/usr/bin/env node
// Claude Code Stop hook. On a factory/ branch, refuses the first stop when the branch changes
// files a Zoom-client spec `covers` and no test-runs/*/run.md written since then names that
// spec. Running those specs is part of done (CLAUDE.md "Definition of done").
// Lets the stop through when: not a factory/ branch, CI or FACTORY_STATION is set (headless
// stations hand off to the Zoom station instead), or this stop already follows a block
// (stop_hook_active), so a blocked run can explain itself and end.
// `node stop-gate.mjs --hits` prints the specs the current branch touches (any branch).
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSpecs, isCovered } from '../lib/zoom-specs.mjs';

const BASE = 'origin/dev';

// Specs whose `covers` include any of `changed`: [{ id, files }].
export function specsHit(specs, changed) {
  return specs
    .map((s) => ({ id: s.id, files: changed.filter((f) => isCovered(f, s.fm.covers || [])) }))
    .filter((s) => s.files.length);
}

// runs: [{ mtime, text }]; changedAt: seconds of the newest change to a covered file.
export function decide({ branch, env = {}, stopHookActive, hits, changedAt, runs }) {
  if (!branch?.startsWith('factory/') || env.CI || env.FACTORY_STATION || stopHookActive) return { block: false };
  const missing = hits.filter((h) => !runs.some((r) => r.mtime > changedAt && r.text.includes(h.id)));
  if (!missing.length) return { block: false };
  const list = missing.map((h) => `${h.id} (${h.files.join(', ')})`).join('; ');
  return {
    block: true,
    reason: `Not done yet (CLAUDE.md "Definition of done"). This branch changes files covered by Zoom-client spec(s): ${list}, and no test-runs/*/run.md written since names them. Run them now with the zoom-app-testing skill: deploy the branch to dev (npm run cf:deploy:dev), .claude/skills/zoom-app-testing/scripts/zoom-up.sh, run the specs, log to run.md. If you are blocked (Mac in use, Zoom sign-in or app authorization, deploy failure): set the spec's status: stale, write the blocker under "Not verified" in the PR, label the PR needs:zoom-test, then stop.`,
  };
}

const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const lines = (s) => s.split('\n').filter(Boolean);

// Files this branch changes against origin/dev, committed or not.
function branchChanges(root) {
  const base = git(root, ['merge-base', 'HEAD', BASE]);
  const dirty = new Set([...lines(git(root, ['diff', '--name-only', 'HEAD'])), ...lines(git(root, ['ls-files', '--others', '--exclude-standard']))]);
  return { base, dirty, changed: [...new Set([...lines(git(root, ['diff', '--name-only', base])), ...dirty])] };
}

function gather(root) {
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!branch.startsWith('factory/')) return { branch };
  const { base, dirty, changed } = branchChanges(root);
  const hits = specsHit(loadSpecs(root), changed);
  if (!hits.length) return { branch, hits };
  const hitFiles = [...new Set(hits.flatMap((h) => h.files))];
  const committed = Number(git(root, ['log', '-1', '--format=%ct', `${base}..HEAD`, '--', ...hitFiles]) || 0);
  const edited = hitFiles.filter((f) => dirty.has(f) && existsSync(join(root, f))).map((f) => statSync(join(root, f)).mtimeMs / 1000);
  const runsDir = join(root, 'test-runs');
  const runs = existsSync(runsDir)
    ? readdirSync(runsDir).map((d) => join(runsDir, d, 'run.md')).filter(existsSync)
      .map((p) => ({ mtime: statSync(p).mtimeMs / 1000, text: readFileSync(p, 'utf8') }))
    : [];
  return { branch, hits, changedAt: Math.max(committed, ...edited), runs };
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--hits') {
  // For the Zoom station: which specs does this branch touch? → [{ id, files }]
  const root = git(process.cwd(), ['rev-parse', '--show-toplevel']);
  console.log(JSON.stringify(specsHit(loadSpecs(root), branchChanges(root).changed), null, 2));
} else if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let input = {};
  try { input = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch {}
  try {
    const root = git(input.cwd || process.cwd(), ['rev-parse', '--show-toplevel']) || join(dirname(fileURLToPath(import.meta.url)), '../..');
    const d = decide({ ...gather(root), env: process.env, stopHookActive: input.stop_hook_active });
    if (d.block) process.stdout.write(JSON.stringify({ decision: 'block', reason: d.reason }));
  } catch {
    // A broken gate must never trap a session: let the stop through.
  }
}
