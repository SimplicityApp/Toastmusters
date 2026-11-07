#!/usr/bin/env node
// Claude Code PreToolUse hook for Edit/Write/MultiEdit/NotebookEdit. On factory/<n>-* branches,
// refuses edits to the oracle tests listed in .factory/oracles/<n>.json (and to that json):
// they were written from the approved plan before the code, so the code must pass them as they
// are. FACTORY_STATION=oracle may write them. CI (check-oracle.mjs) catches edits made any
// other way.
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { issueOfBranch } from './state.mjs';

export const oraclePath = (n) => `.factory/oracles/${n}.json`;

// → reason string when the edit must be refused, else null.
export function refusal({ branch, station, file, oracle }) {
  const n = issueOfBranch(branch);
  if (!n || !oracle || station === 'oracle' || !file) return null;
  if (file !== oraclePath(n) && !oracle.files.includes(file)) return null;
  return `${file} is an oracle test for #${n}: written from the approved plan before the code. Make the code pass it as it is. If the test itself is wrong, stop: comment on the PR which assertion and why, add the factory:stuck label, and end.`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
    const cwd = input.cwd || process.cwd();
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim();
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const n = issueOfBranch(branch);
    const jsonPath = n && join(root, oraclePath(n));
    const oracle = jsonPath && existsSync(jsonPath) ? JSON.parse(readFileSync(jsonPath, 'utf8')) : null;
    const raw = input.tool_input?.file_path || input.tool_input?.notebook_path;
    const file = raw && (isAbsolute(raw) ? relative(root, raw) : raw);
    const reason = refusal({ branch, station: process.env.FACTORY_STATION, file, oracle });
    if (reason) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
      }));
    }
  } catch {
    // Never block ordinary work because the guard itself broke; CI is the backstop.
  }
}
