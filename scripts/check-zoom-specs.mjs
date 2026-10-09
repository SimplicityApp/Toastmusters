#!/usr/bin/env node
// Validates e2e/zoom-client/*.md. Exit 1 on malformed specs or dangling `covers` paths.
// --stale   also list specs whose `covers` files changed since `verified_at` (not rerun).
// --drift   exit 1 when a `covers` file was committed after the spec itself was last edited
//           (the doc was not reviewed against the code change). Used by the pre-push hook.
// --review  with --drift, ask `claude -p` whether the code diff actually contradicts the spec's
//           steps. A drifted spec the reviewer clears (verdict "ok") passes; "update" blocks with
//           reasons. Verdicts are cached in .git/zoom-spec-reviews.json by (spec, code sha).
//           If claude is missing or fails, drift blocks as without --review.
// --strict  with --stale, exit 1 when any spec is stale.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'e2e/zoom-client');
const args = new Set(process.argv.slice(2));
const STATUSES = ['current', 'draft', 'stale'];
const STEP = /^### ([A-Z]+-\d+) · (auto|human) · .+$/gm;
const cachePath = join(root, '.git/zoom-spec-reviews.json');
const readCache = () => { try { return JSON.parse(readFileSync(cachePath, 'utf8')); } catch { return {}; } };
const SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    verdict: { enum: ['ok', 'update'] },
    reasons: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict', 'reasons'],
});

// Ask claude -p whether `diff` makes any step in `spec` wrong. Returns {verdict, reasons} or null.
function reviewWithClaude(file, spec, diff) {
  const prompt = `You review a manual test spec against a code change.

The spec describes user-visible behaviour of the Toastmusters Zoom app, to be tested in the real Zoom client.
Reply verdict "update" only if the diff changes behaviour in a way that makes at least one step's Do/Expect/Evidence wrong, incomplete, or leaves a new behaviour in its covered area untested.
Reply "ok" for refactors, renames, formatting, comments, tests, or changes the spec does not describe.
In "reasons" cite the step ID (or "NEW") and the diff hunk, one short sentence each. Empty for "ok".

=== SPEC ${file} ===
${spec}

=== CODE DIFF SINCE THE SPEC WAS LAST EDITED ===
${diff.slice(0, 60000)}`;
  try {
    const out = execFileSync('claude', ['-p', '--tools', '', '--no-session-persistence', '--model', 'sonnet', '--output-format', 'json', '--json-schema', SCHEMA], {
      cwd: root, input: prompt, encoding: 'utf8', timeout: 120000, maxBuffer: 10 * 1024 * 1024,
    });
    const res = JSON.parse(out);
    const v = res.structured_output ?? JSON.parse(res.result);
    return ['ok', 'update'].includes(v.verdict) ? v : null;
  } catch { return null; }
}

const errors = [];
const stale = [];
const drift = [];
const lastCommit = (paths) => {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%ct%x09%h%x09%s', '--', ...paths], { cwd: root, encoding: 'utf8' }).trim();
    if (!out) return null;
    const [t, sha, ...subj] = out.split('\t');
    return { t: Number(t), sha, subject: subj.join('\t') };
  } catch { return null; }
};

function frontMatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return null;
  const out = {};
  let key = null;
  for (const line of m[1].split('\n')) {
    const item = line.match(/^\s+- (.+)$/);
    if (item && key) { out[key].push(item[1].trim()); continue; }
    const kv = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!kv) continue;
    key = kv[1];
    out[key] = kv[2] === '' ? [] : kv[2] === '[]' ? [] : kv[2].trim();
  }
  return out;
}

const files = readdirSync(dir).filter((f) => f.endsWith('.md') && !['README.md', 'INDEX.md', '_template.md'].includes(f));
const index = readFileSync(join(dir, 'INDEX.md'), 'utf8');

for (const f of files) {
  const text = readFileSync(join(dir, f), 'utf8');
  const fm = frontMatter(text);
  const at = (msg) => errors.push(`${f}: ${msg}`);
  if (!fm) { at('missing front matter'); continue; }
  const id = f.replace(/\.md$/, '');
  if (fm.id !== id) at(`id "${fm.id}" must equal file name "${id}"`);
  if (!STATUSES.includes(fm.status)) at(`status must be one of ${STATUSES.join('|')}`);
  for (const k of ['covers', 'automated', 'needs']) if (!Array.isArray(fm[k])) at(`${k} must be a list`);
  if (!fm.verified_at || !fm.verified_on) at('verified_at and verified_on are required (use "never")');
  if (Array.isArray(fm.covers) && fm.covers.length === 0) at('covers must list at least one path');
  for (const p of [...(fm.covers || []), ...(fm.automated || [])]) {
    if (!existsSync(join(root, p))) at(`path does not exist: ${p}`);
  }
  const ids = [...text.matchAll(STEP)].map((m) => m[1]);
  if (ids.length === 0) at('no steps; expected "### XX-01 · auto|human · title"');
  if (new Set(ids).size !== ids.length) at('duplicate step ids');
  for (const m of text.matchAll(/^### (.+)$/gm)) {
    if (/^[A-Z]+-\d+ /.test(m[1]) && !new RegExp(`^### ${m[1].split(' ')[0]} · (auto|human) · `, 'm').test(text)) at(`malformed step heading: ${m[1]}`);
  }
  if (!index.includes(`(${f})`)) at('not listed in INDEX.md');

  if (args.has('--drift')) {
    const specAt = lastCommit([`e2e/zoom-client/${f}`]);
    const codeAt = lastCommit(fm.covers || []);
    if (specAt && codeAt && codeAt.t > specAt.t) {
      let note = '';
      if (args.has('--review')) {
        const cache = readCache();
        const key = `${f}@${codeAt.sha}`;
        let v = cache[key];
        if (!v) {
          const diff = execFileSync('git', ['diff', `${specAt.sha}..HEAD`, '--', ...fm.covers], { cwd: root, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
          v = reviewWithClaude(f, text, diff);
          if (v) { cache[key] = v; try { writeFileSync(cachePath, JSON.stringify(cache, null, 1)); } catch {} }
        }
        if (v?.verdict === 'ok') { console.log(`✓ ${f}: code changed since the spec was edited, claude review: no step affected`); continue; }
        note = v ? `\n    claude review says the spec needs an update:\n      - ${v.reasons.join('\n      - ')}` : '\n    (claude review unavailable; blocking on drift)';
      }
      drift.push(`${f}: covered code changed in ${codeAt.sha} "${codeAt.subject}" after the spec was last edited (${specAt.sha}).\n    Review the steps against that change and commit the spec (even a no-op edit of \`status\`/notes), or push with --no-verify.${note}`);
    }
  }
  if (args.has('--stale') && fm.status !== 'draft' && fm.verified_at !== 'never') {
    try {
      const changed = execFileSync('git', ['diff', '--name-only', `${fm.verified_at}..HEAD`, '--', ...fm.covers], { cwd: root, encoding: 'utf8' }).trim();
      if (changed) stale.push(`${f}: ${changed.split('\n').length} covered file(s) changed since ${fm.verified_at}\n    ${changed.split('\n').join('\n    ')}`);
    } catch { errors.push(`${f}: verified_at ${fm.verified_at} is not a known commit`); }
  }
}

for (const e of errors) console.error(`✗ ${e}`);
for (const d of drift) console.error(`✗ drift  ${d}`);
for (const s of stale) console.warn(`⚠ stale  ${s}`);
if (!errors.length) console.log(`✓ ${files.length} zoom-client spec(s) valid`);
process.exit(errors.length || drift.length || (args.has('--strict') && stale.length) ? 1 : 0);
