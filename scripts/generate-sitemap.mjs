#!/usr/bin/env node
/**
 * Generate apps/web/public/sitemap.xml.
 *
 * lastmod comes from each source file's last git commit date, so the sitemap
 * stays honest without anyone remembering to touch it. Answer engines weight
 * freshness heavily and a stale hand-maintained lastmod is worse than none —
 * it claims an update that did not happen.
 *
 * Output is written back into public/ (not dist/) so the generated file is
 * reviewable in version control and vite copies it on the next build.
 *
 * Run: node scripts/generate-sitemap.mjs
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, statSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://www.toastmusters.com';
const OUT = resolve(ROOT, 'apps/web/public/sitemap.xml');

/**
 * Every indexable URL, with the source file its lastmod is derived from.
 *
 * Deliberately absent:
 *  - /timer/app and /oauth/redirect — the SPA shell has no static content of its own
 *    and canonicalises to the home page.
 *  - /404.html — noindex.
 *  - /zoom/* — the Zoom app is noindex.
 */
const PAGES = [
  { path: '/', file: 'apps/web/index.html', priority: '1.0', changefreq: 'weekly' },

  // Content / SEO pages
  { path: '/toastmasters-timer-role-guide', file: 'apps/web/public/toastmasters-timer-role-guide.html', priority: '0.8', changefreq: 'monthly' },
  { path: '/toastmasters-speech-types-and-timing', file: 'apps/web/public/toastmasters-speech-types-and-timing.html', priority: '0.8', changefreq: 'monthly' },
  { path: '/toastmasters-timing-chart', file: 'apps/web/public/toastmasters-timing-chart.html', priority: '0.8', changefreq: 'monthly' },
  { path: '/toastmasters-timer-script', file: 'apps/web/public/toastmasters-timer-script.html', priority: '0.8', changefreq: 'monthly' },
  { path: '/table-topics-timer', file: 'apps/web/public/table-topics-timer.html', priority: '0.8', changefreq: 'monthly' },
  { path: '/toastmasters-speech-contest-timing-rules', file: 'apps/web/public/toastmasters-speech-contest-timing-rules.html', priority: '0.8', changefreq: 'yearly' },
  { path: '/how-to-use-zoom-for-toastmasters', file: 'apps/web/public/how-to-use-zoom-for-toastmasters.html', priority: '0.8', changefreq: 'monthly' },
  { path: '/toastmasters-zoom-timer-backgrounds', file: 'apps/web/public/toastmasters-zoom-timer-backgrounds.html', priority: '0.8', changefreq: 'monthly' },
  { path: '/best-toastmasters-timer-apps', file: 'apps/web/public/best-toastmasters-timer-apps.html', priority: '0.8', changefreq: 'monthly' },

  // Video pages
  { path: '/toastmasters-timer-demo', file: 'apps/web/public/toastmasters-timer-demo.html', priority: '0.6', changefreq: 'monthly' },
  { path: '/toastmasters-timer-zoom-demo', file: 'apps/web/public/toastmasters-timer-zoom-demo.html', priority: '0.6', changefreq: 'monthly' },

  // Legal / support (served from the zoom app's public dir at the root path)
  { path: '/documentation', file: 'apps/zoom-app/public/documentation.html', priority: '0.5', changefreq: 'monthly' },
  { path: '/support', file: 'apps/zoom-app/public/support.html', priority: '0.3', changefreq: 'yearly' },
  { path: '/privacy', file: 'apps/zoom-app/public/privacy.html', priority: '0.3', changefreq: 'yearly' },
  { path: '/terms-of-use', file: 'apps/zoom-app/public/terms-of-use.html', priority: '0.3', changefreq: 'yearly' },
];

/**
 * Whether git history is usable here. CI checkouts are often shallow (or have
 * no .git at all), in which case per-file `git log` returns nothing for every
 * file outside the tip commit and we must NOT fall back to mtime — in a fresh
 * clone that is the checkout time, which would stamp every URL with the deploy
 * date and claim an update that did not happen.
 */
function gitHistoryUsable() {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cs'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(out)) return false;
    // A depth-1 clone has exactly one commit; per-file history is meaningless.
    const depth = execFileSync('git', ['rev-list', '--count', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return Number(depth) > 1;
  } catch {
    return false;
  }
}

/** lastmod values already published in the committed sitemap, by URL path. */
function committedLastmods() {
  if (!existsSync(OUT)) return {};
  try {
    const xml = readFileSync(OUT, 'utf8');
    const out = {};
    const re = /<loc>([^<]+)<\/loc>\s*(?:<lastmod>([^<]*)<\/lastmod>)?/g;
    for (const m of xml.matchAll(re)) {
      if (m[2]) out[m[1].replace(ORIGIN, '')] = m[2];
    }
    return out;
  } catch {
    return {};
  }
}

/** Last git commit date for a file (YYYY-MM-DD), or null if unavailable. */
function gitLastModified(relPath) {
  try {
    const out = execFileSync(
      'git',
      ['log', '-1', '--format=%cs', '--', relPath],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

/** Filesystem mtime as YYYY-MM-DD. Used for files git has not seen yet. */
function fileMtime(relPath) {
  const abs = resolve(ROOT, relPath);
  if (!existsSync(abs)) return null;
  return statSync(abs).mtime.toISOString().slice(0, 10);
}

const missing = [];
const HAVE_GIT = gitHistoryUsable();
const PUBLISHED = HAVE_GIT ? {} : committedLastmods();
if (!HAVE_GIT) {
  console.warn(
    'generate-sitemap: git history unavailable (shallow clone?) — keeping the ' +
      'lastmod values already committed in sitemap.xml and omitting the rest. ' +
      'Regenerate locally, with full history, to refresh them.'
  );
}
const entries = PAGES.map((page) => {
  if (!existsSync(resolve(ROOT, page.file))) missing.push(page.file);
  // With real history: commit date, then mtime for a page git has not seen yet.
  // Without it: reuse what we already published rather than inventing a date —
  // mtime in a fresh checkout is the deploy time, not a content change.
  const lastmod = HAVE_GIT
    ? gitLastModified(page.file) || fileMtime(page.file) || null
    : PUBLISHED[page.path] || null;
  return { ...page, lastmod };
});

if (missing.length) {
  console.error('generate-sitemap: source file(s) not found:\n  ' + missing.join('\n  '));
  process.exit(1);
}

const xml = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<!-- Generated by scripts/generate-sitemap.mjs — do not edit by hand. -->',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ...entries.map((e) =>
    [
      '  <url>',
      `    <loc>${ORIGIN}${e.path}</loc>`,
      e.lastmod ? `    <lastmod>${e.lastmod}</lastmod>` : null,
      `    <changefreq>${e.changefreq}</changefreq>`,
      `    <priority>${e.priority}</priority>`,
      '  </url>',
    ]
      .filter(Boolean)
      .join('\n')
  ),
  '</urlset>',
  '',
].join('\n');

writeFileSync(OUT, xml, 'utf8');
console.log(`generate-sitemap: wrote ${entries.length} URLs to ${OUT.replace(ROOT + '/', '')}`);
