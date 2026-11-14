#!/usr/bin/env node
// Where an issue is in the factory and what runs next: the one reader of the label state
// machine (.factory/README.md). Skills and workflows ask this instead of re-deriving it.
//   node scripts/factory/state.mjs <issue>   → { issue, title, branch, pr, labels, next, gate, reason }
//   node scripts/factory/state.mjs --queue   → { inFlight, ready, pick }  (pick = next issue to plan, WIP allowing)
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Labels only a human may open a gate with. Anyone else adding them is ignored.
export const HUMAN_GATES = ['factory:ready', 'plan:approved'];

// Of `labels`, the human-gate ones whose latest "labeled" event came from an actor.
export function trustedGates(events, actors) {
  const last = {};
  for (const e of events) if (HUMAN_GATES.includes(e.label)) last[e.label] = e.actor;
  return HUMAN_GATES.filter((l) => actors.includes(last[l]));
}

// issue: { state, labels }, pr: { state, labels } | null, trusted: human gates an actor opened.
export function nextStep({ issue, pr, trusted = HUMAN_GATES }) {
  const raw = new Set([...(issue.labels || []), ...(pr?.labels || [])]);
  const has = (l) => raw.has(l) && (!HUMAN_GATES.includes(l) || trusted.includes(l));
  if (pr?.state === 'MERGED' || issue.state === 'CLOSED') return { next: null, gate: null, reason: 'done' };
  if (pr?.state === 'CLOSED') return { next: null, gate: 'stuck', reason: 'the PR was closed without merging' };
  if (has('factory:stuck')) return { next: null, gate: 'stuck', reason: 'a station failed twice; read its last PR comment' };
  if (has('ready-for-review')) return { next: null, gate: 'merge', reason: 'report written; review and merge' };
  if (has('zoom:testing')) return { next: null, gate: null, busy: 'zoom', reason: 'the Zoom station is running on it' };
  if (has('needs:zoom-test')) return { next: 'zoom', gate: null, reason: 'built and verified; waiting for the real-Zoom run' };
  if (has('plan:approved')) return { next: 'build', gate: null, reason: 'plan approved' };
  if (has('plan:review')) return { next: null, gate: 'plan', reason: "answer the plan's open questions, then add plan:approved" };
  if (has('factory:ready')) return { next: 'plan', gate: null, reason: 'promoted' };
  const untrusted = HUMAN_GATES.filter((l) => raw.has(l) && !trusted.includes(l));
  if (untrusted.length) return { next: null, gate: 'promote', reason: `${untrusted.join(', ')} was not added by a factory actor; ignored` };
  return { next: null, gate: 'promote', reason: raw.has('idea') ? 'an idea; promote it with factory:ready' : 'not in the factory; add factory:ready' };
}

// Oldest ready issue without a PR, when fewer than wipLimit factory PRs are open.
export function pickNext({ ready, inFlight, wipLimit }) {
  if (inFlight.length >= wipLimit) return null;
  const busy = new Set(inFlight.map((p) => p.issue));
  return ready.map((i) => i.number).filter((n) => !busy.has(n)).sort((a, b) => a - b)[0] ?? null;
}

export const issueOfBranch = (branch) => Number(branch?.match(/^factory\/(\d+)-/)?.[1]) || null;

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const config = () => JSON.parse(readFileSync(join(root, '.factory/config.json'), 'utf8'));
const gh = (args) => JSON.parse(execFileSync(join(root, 'scripts/factory/gh.sh'), args, { cwd: root, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }) || 'null');
const names = (labels) => (labels || []).map((l) => l.name);
const factoryPrs = () => gh(['pr', 'list', '--state', 'all', '--limit', '200', '--json', 'number,headRefName,state,labels,isDraft,url'])
  .filter((p) => issueOfBranch(p.headRefName))
  .map((p) => ({ ...p, issue: issueOfBranch(p.headRefName), labels: names(p.labels) }));
const labelEvents = (n) => gh(['api', '--paginate', `repos/{owner}/{repo}/issues/${n}/events`, '--jq', '[.[] | select(.event=="labeled") | {label: .label.name, actor: .actor.login}]'])
  || [];

function issueState(n) {
  const issue = gh(['issue', 'view', String(n), '--json', 'number,title,state,labels']);
  const prs = factoryPrs().filter((p) => p.issue === n);
  const pr = prs.find((p) => p.state === 'OPEN') || prs[0] || null;
  const events = [...labelEvents(n), ...(pr ? labelEvents(pr.number) : [])];
  const trusted = trustedGates(events, config().actors);
  const labels = names(issue.labels);
  return {
    issue: n, title: issue.title, branch: pr?.headRefName ?? null, pr: pr?.number ?? null, prUrl: pr?.url ?? null,
    labels: [...new Set([...labels, ...(pr?.labels || [])])],
    ...nextStep({ issue: { state: issue.state, labels }, pr, trusted }),
  };
}

function queue() {
  const { wipLimit } = config();
  const inFlight = factoryPrs().filter((p) => p.state === 'OPEN');
  const ready = gh(['issue', 'list', '--state', 'open', '--label', 'factory:ready', '--json', 'number,title']);
  return { wipLimit, inFlight: inFlight.map((p) => ({ issue: p.issue, pr: p.number, labels: p.labels })), ready, pick: pickNext({ ready, inFlight, wipLimit }) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = process.argv[2];
  if (!arg) { console.error('usage: state.mjs <issue> | --queue'); process.exit(1); }
  console.log(JSON.stringify(arg === '--queue' ? queue() : issueState(Number(arg)), null, 2));
}
