#!/usr/bin/env node
// Render the whole site from content/questions.json into ./dist.
//
//   node scripts/build.mjs            # uses content/questions.json
//   SITE_ORIGIN=https://www.timer-dev.toastmusters.com/tabletopics node scripts/build.mjs
//
// SITE_ORIGIN may carry a path. The site then lives under it: every page,
// asset and root-relative link is prefixed, so www.toastmusters.com can serve
// it at /tabletopics through the timer Worker.
//
// Env (all optional): SITE_ORIGIN, BUILD_DATE (YYYY-MM-DD), QUESTIONS_FILE,
// VITE_PUBLIC_POSTHOG_KEY, VITE_PUBLIC_POSTHOG_HOST (fall back to the repo-root .env).
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve, join, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS, TIMER_APP_URL } from '@toastmaster-timer/shared/appLinks';
import { validateBank } from '../src/lib/validate.js';
import { flattenQuestions, drawSet, todaySet, utcDateString } from '../src/lib/picker.js';
import { SET_SIZE } from '../src/templates/widget.mjs';
import { indexPage } from '../src/templates/index.mjs';
import { categoryPage } from '../src/templates/category.mjs';
import { topicsPage } from '../src/templates/topics.mjs';
import { todayPage } from '../src/templates/today.mjs';
import { notFoundPage } from '../src/templates/notFound.mjs';

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(APP_ROOT, '../..');
const DEFAULT_ORIGIN = 'https://www.toastmusters.com/tabletopics';

// Copied from apps/web/public/robots.txt: AI answer engines are an acquisition
// channel for a free tool, so they are allow-listed explicitly.
const AI_BOTS = ['OAI-SearchBot', 'ChatGPT-User', 'GPTBot', 'PerplexityBot', 'Perplexity-User', 'ClaudeBot', 'Claude-User', 'Claude-SearchBot', 'Google-Extended', 'Applebot-Extended', 'DuckAssistBot', 'CCBot'];

/** Minimal .env parser (KEY=value lines, optional quotes). */
export function parseDotEnv(text) {
  const out = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    out[key] = val;
  }
  return out;
}

export function longDate(dateStr) {
  return new Date(`${dateStr}T00:00:00Z`).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

/**
 * Turn the browser sources into two self-contained files without a bundler:
 * lib modules are inlined above generator.js with `import`/`export` stripped.
 * Returns { 'generator.js': code, 'analytics.js': code, 'tabletopics.css': css, 'content-pages.css': css }.
 */
export function buildAssets({ posthogKey, posthogHost, timerAppUrl, basePath = '' }) {
  const read = (p) => readFileSync(p, 'utf8');
  const strip = (code) =>
    code
      .replace(/^import\s[^\n]*\n/gm, '')
      .replace(/^export\s+(function|const|let|class)\s/gm, '$1 ')
      .replace(/^export\s*\{[^}]*\};?\s*$/gm, '');
  const libs = ['rng.js', 'picker.js', 'links.js'].map((f) => strip(read(join(APP_ROOT, 'src/lib', f))));
  const gen = strip(read(join(APP_ROOT, 'src/generator.js')))
    .replace('__TIMER_APP_URL__', timerAppUrl)
    .replace('__BASE_PATH__', basePath);
  const generator = `// Built from src/lib/{rng,picker,links}.js + src/generator.js\n${libs.join('\n')}\n${gen}`;
  const analytics = read(join(APP_ROOT, 'src/analytics.js')).replace('__POSTHOG_KEY__', posthogKey || '').replace('__POSTHOG_HOST__', posthogHost || '');
  return {
    'generator.js': generator,
    'analytics.js': analytics,
    'tabletopics.css': read(join(APP_ROOT, 'src/styles/tabletopics.css')),
    'content-pages.css': read(join(REPO_ROOT, 'packages/ui/content-pages.css')),
  };
}

export function hashedName(name, content) {
  const hash = createHash('sha1').update(content).digest('hex').slice(0, 8);
  const ext = extname(name);
  return `/assets/${basename(name, ext)}.${hash}${ext}`;
}

/**
 * Move a rendered site under `basePath`: every output path, and every
 * root-relative href/src in its HTML (the templates write "/topics/…"). A
 * protocol-relative "//host" is left alone, and so are absolute URLs, which
 * already carry the base through siteOrigin.
 */
export function applyBasePath(out, basePath) {
  if (!basePath) return out;
  const moved = new Map();
  for (const [path, content] of out) {
    const body = path.endsWith('.html') ? content.replace(/\b(href|src)="\/(?!\/)/g, `$1="${basePath}/`) : content;
    moved.set(`${basePath}${path}`, body);
  }
  return moved;
}

/** Pure: bank + config -> Map of output path -> file contents. */
export function renderSite(bank, config) {
  const out = new Map();
  const pool = flattenQuestions(bank.categories);
  const seed = `home:${config.buildDate}`;

  out.set('/index.html', indexPage(config, bank, drawSet(pool, seed, SET_SIZE).questions));
  out.set('/topics/index.html', topicsPage(config, bank));
  for (const cat of bank.categories) {
    const catPool = pool.filter((q) => q.category === cat.slug);
    out.set(`/topics/${cat.slug}/index.html`, categoryPage(config, bank, cat, drawSet(catPool, `${cat.slug}:${config.buildDate}`, SET_SIZE).questions));
  }
  out.set('/today/index.html', todayPage(config, bank, todaySet(bank.categories, config.buildDate, 10)));
  out.set('/404.html', notFoundPage(config));

  // Machine-readable copies.
  out.set('/questions.json', JSON.stringify(bank));

  const urls = [
    { loc: '/', priority: '1.0', changefreq: 'weekly', lastmod: config.buildDate },
    { loc: '/topics/', priority: '0.8', changefreq: 'weekly', lastmod: config.buildDate },
    { loc: '/today/', priority: '0.6', changefreq: 'weekly', lastmod: config.buildDate },
    ...bank.categories.map((c) => ({
      loc: `/topics/${c.slug}/`,
      priority: '0.7',
      changefreq: 'weekly',
      lastmod: c.questions.map((q) => q.added).sort().at(-1),
    })),
  ];
  out.set(
    '/sitemap.xml',
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
      .map((u) => `  <url>\n    <loc>${config.siteOrigin}${u.loc}</loc>\n    <lastmod>${u.lastmod}</lastmod>\n    <changefreq>${u.changefreq}</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`)
      .join('\n')}\n</urlset>\n`
  );

  out.set(
    '/robots.txt',
    `# Table Topics Generator — ${config.siteOrigin}/\n# All crawlers welcome. AI assistants: see /llms.txt for a structured summary.\n\nUser-agent: *\nAllow: /\n\n${AI_BOTS.map((b) => `User-agent: ${b}\nAllow: /`).join('\n\n')}\n\nSitemap: ${config.siteOrigin}/sitemap.xml\n`
  );

  const total = pool.length;
  out.set(
    '/llms.txt',
    `# Table Topics Generator\n\n> Free random Table Topics question generator for Toastmasters meetings: ${total} open-ended impromptu speaking prompts in ${bank.categories.length} categories, each answerable in 1–2 minutes, with a one-click timer. Independent tool, not affiliated with Toastmasters International.\n\n## Pages\n\n- [Generator](${config.siteOrigin}/): draw a random question, filter by category, copy, share, or time it.\n- [Today's set](${config.siteOrigin}/today/): ten questions for today, one per category where possible.\n- [All categories](${config.siteOrigin}/topics/)\n\n## Categories\n\n${bank.categories.map((c) => `- [${c.name}](${config.siteOrigin}/topics/${c.slug}/): ${c.description} (${c.questions.length} questions)`).join('\n')}\n\n## Data\n\n- [questions.json](${config.siteOrigin}/questions.json): the full bank as JSON.\n- Related: [Toastmusters Timer](${config.tools.find((t) => t.slug === 'timer')?.url ?? ''}/) for timing speeches.\n`
  );
  return applyBasePath(out, config.basePath);
}

export function loadConfig(env = process.env) {
  let dotenv = {};
  const envPath = join(REPO_ROOT, '.env');
  if (existsSync(envPath)) dotenv = parseDotEnv(readFileSync(envPath, 'utf8'));
  const posthogKey = env.VITE_PUBLIC_POSTHOG_KEY ?? dotenv.VITE_PUBLIC_POSTHOG_KEY ?? '';
  const posthogHost = env.VITE_PUBLIC_POSTHOG_HOST ?? dotenv.VITE_PUBLIC_POSTHOG_HOST ?? 'https://e.simple-tech.app';
  const siteOrigin = (env.SITE_ORIGIN || DEFAULT_ORIGIN).replace(/\/$/, '');
  const basePath = new URL(siteOrigin).pathname.replace(/\/$/, '');
  const buildDate = env.BUILD_DATE || utcDateString();
  return {
    siteOrigin,
    basePath,
    rootOrigin: 'https://www.toastmusters.com',
    timerAppUrl: TIMER_APP_URL,
    timerOrigin: TOOLS.find((t) => t.slug === 'timer')?.url ?? 'https://www.toastmusters.com',
    tools: TOOLS,
    posthogKey,
    posthogHost,
    buildDate,
    buildDateLong: longDate(buildDate),
    assets: {},
  };
}

export function build({ questionsFile, distDir, env = process.env } = {}) {
  const config = loadConfig(env);
  const file = questionsFile || env.QUESTIONS_FILE || join(APP_ROOT, 'content/questions.json');
  const dist = distDir || join(APP_ROOT, 'dist');
  const bank = JSON.parse(readFileSync(file, 'utf8'));
  const problems = validateBank(bank);
  if (problems.length) {
    throw new Error(`questions.json has ${problems.length} problem(s):\n  - ${problems.join('\n  - ')}`);
  }

  const assets = buildAssets(config);
  for (const [name, content] of Object.entries(assets)) config.assets[name] = hashedName(name, content);

  // config.assets stays root-relative: the templates link to it, and
  // applyBasePath prefixes those links along with every other one.
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(join(dist, config.basePath, 'assets'), { recursive: true });
  for (const [name, content] of Object.entries(assets)) writeFileSync(join(dist, config.basePath, config.assets[name]), content);

  const pages = renderSite(bank, config);
  for (const [path, content] of pages) {
    const target = join(dist, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  const pub = join(APP_ROOT, 'public');
  if (existsSync(pub)) {
    const target = join(dist, config.basePath);
    cpSync(pub, target, { recursive: true });
    // The manifest's start_url and icons are root-relative too.
    const manifest = join(target, 'site.webmanifest');
    if (config.basePath && existsSync(manifest)) {
      writeFileSync(manifest, readFileSync(manifest, 'utf8').replace(/"(start_url|src)": "\/(?!\/)/g, `"$1": "${config.basePath}/`));
    }
  }

  return { pages: pages.size, assets: Object.keys(assets).length, dist, publicFiles: existsSync(pub) ? readdirSync(pub).length : 0, config };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const r = build();
    console.log(`✓ built ${r.pages} files + ${r.assets} assets + ${r.publicFiles} public files → ${r.dist} (origin ${r.config.siteOrigin}, date ${r.config.buildDate}, posthog ${r.config.posthogKey ? 'on' : 'off'})`);
  } catch (err) {
    console.error(`✗ build failed: ${err.message}`);
    process.exit(1);
  }
}
