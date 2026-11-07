// Shared reader for e2e/zoom-client/*.md specs (check-zoom-specs.mjs, the factory hooks).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const SPEC_DIR = 'e2e/zoom-client';
const NOT_SPECS = ['README.md', 'INDEX.md', '_template.md'];

// Flat `key: value` front matter, lists as `- item`. Returns null when there is none.
export function frontMatter(text) {
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

export const specFiles = (root) =>
  readdirSync(join(root, SPEC_DIR)).filter((f) => f.endsWith('.md') && !NOT_SPECS.includes(f));

// [{ file, id, fm, text }] for every spec with front matter.
export function loadSpecs(root) {
  return specFiles(root).flatMap((file) => {
    const text = readFileSync(join(root, SPEC_DIR, file), 'utf8');
    const fm = frontMatter(text);
    return fm ? [{ file, id: file.replace(/\.md$/, ''), fm, text }] : [];
  });
}

// True when `file` is a `covers` entry or sits under one (entries may be directories).
export const isCovered = (file, covers) =>
  covers.some((c) => { const p = c.replace(/\/$/, ''); return file === p || file.startsWith(`${p}/`); });
