import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderSite, buildAssets, hashedName, parseDotEnv, build } from '../scripts/build.mjs';
import { validateBank } from '../src/lib/validate.js';
import { fixtureBank, fixtureConfig } from './fixtures.js';

const bank = fixtureBank();
const site = renderSite(bank, fixtureConfig);
const html = (p) => site.get(p);
const jsonLdTypes = (doc) => {
  const m = /<script type="application\/ld\+json">\n([\s\S]*?)\n<\/script>/.exec(doc);
  return JSON.parse(m[1])['@graph'].map((n) => n['@type']);
};

describe('renderSite', () => {
  it('fixture bank is valid', () => {
    expect(validateBank(bank)).toEqual([]);
  });

  it('emits every expected path', () => {
    expect([...site.keys()].sort()).toEqual(
      ['/404.html', '/index.html', '/llms.txt', '/questions.json', '/robots.txt', '/sitemap.xml', '/today/index.html', '/topics/icebreakers/index.html', '/topics/index.html', '/topics/leadership/index.html', '/topics/travel-places/index.html'].sort()
    );
  });

  it('home: title, canonical, og:url, WebApplication + FAQPage, widget with chips', () => {
    const doc = html('/index.html');
    expect(doc).toContain('<title>Table Topics Generator – 48+ Random Table Topics Questions for Toastmasters</title>');
    expect(doc).toContain('<link rel="canonical" href="https://www.tabletopics.toastmusters.com/" />');
    expect(doc).toContain('<meta property="og:url" content="https://www.tabletopics.toastmusters.com/" />');
    expect(jsonLdTypes(doc)).toEqual(['Organization', 'WebSite', 'WebApplication', 'FAQPage', 'BreadcrumbList']);
    expect(doc).toContain('data-tt-generator data-tt-category=""');
    expect((doc.match(/data-tt-item /g) || []).length).toBe(3); // a set of three
    expect(doc).toMatch(/data-tt-initial="[a-z-]+-\d{3},[a-z-]+-\d{3},[a-z-]+-\d{3}"/);
    expect((doc.match(/data-tt-chip=/g) || []).length).toBe(4); // All + 3
    expect(doc).toContain('/topics/travel-places/');
    expect(doc).not.toContain('<meta name="robots"');
  });

  it('category: Article + BreadcrumbList + ItemList, full list, escaped text, deep links', () => {
    const doc = html('/topics/icebreakers/index.html');
    expect(doc).toContain('<link rel="canonical" href="https://www.tabletopics.toastmusters.com/topics/icebreakers/" />');
    expect(jsonLdTypes(doc)).toEqual(['Organization', 'WebSite', 'Article', 'BreadcrumbList', 'ItemList']);
    expect(doc).toContain('id="icebreakers-016"');
    expect((doc.match(/class="tt-list-time"/g) || []).length).toBe(16);
    // HTML-escaped question text, no raw angle brackets from the fixture
    expect(doc).toContain('&lt;topic a&gt;');
    expect(doc).toContain('"quoted" &amp; &lt;topic a&gt;');
    expect(doc).not.toContain('<topic a>');
    expect(doc).toContain('href="https://www.timer.toastmusters.com/app?role=Table%20Topics%20Speech&amp;name=');
    // Crawlers must not follow one timer URL per question.
    expect(doc).not.toMatch(/name=[^"]*" rel="noopener"/);
    expect(doc).toContain('rel="nofollow noopener" data-tt-list-time');
    expect(doc).toContain('data-tt-generator data-tt-category="icebreakers"');
    expect((doc.match(/data-tt-item /g) || []).length).toBe(3);
    expect((doc.match(/data-tt-initial="([^"]+)"/) || [])[1].split(',').every((id) => id.startsWith('icebreakers-'))).toBe(true);
    expect(doc).not.toContain('data-tt-chip');
  });

  it('category list is collapsible only above 40 questions, with the full list always in the HTML', () => {
    const small = html('/topics/icebreakers/index.html');
    expect(small).toContain('data-tt-collapsible');
    expect(small).not.toContain('data-tt-show-all');
    const big = fixtureBank(1, 16);
    big.categories[0].questions = Array.from({ length: 45 }, (_, i) => ({
      id: `icebreakers-${String(i + 1).padStart(3, '0')}`,
      text: `Filler ${i} about ${['sun', 'moon', 'rain', 'wind', 'snow'][i % 5]} number ${i * 7}?`,
      added: '2026-09-02',
    }));
    const doc = renderSite(big, fixtureConfig).get('/topics/icebreakers/index.html');
    expect(doc).toContain('data-tt-show-all="tt-list" hidden>Show all 45 questions</button>');
    expect((doc.match(/<li id="icebreakers-/g) || []).length).toBe(45);
  });

  it('topics index: CollectionPage + BreadcrumbList + ItemList', () => {
    expect(jsonLdTypes(html('/topics/index.html'))).toEqual(['Organization', 'WebSite', 'CollectionPage', 'BreadcrumbList', 'ItemList']);
  });

  it('today: WebPage + BreadcrumbList, 10 questions, built-for date', () => {
    const doc = html('/today/index.html');
    expect(jsonLdTypes(doc)).toEqual(['Organization', 'WebSite', 'WebPage', 'BreadcrumbList']);
    expect(doc).toContain('data-tt-today data-built-for="2026-09-02"');
    expect((doc.match(/<li id="/g) || []).length).toBe(10);
    expect(doc).toContain('September 2, 2026');
  });

  it('404 is noindex', () => {
    expect(html('/404.html')).toContain('<meta name="robots" content="noindex, nofollow" />');
  });

  it('sitemap lists home, topics, today and every category with lastmod', () => {
    const xml = html('/sitemap.xml');
    expect((xml.match(/<loc>/g) || []).length).toBe(6);
    expect(xml).toContain('<loc>https://www.tabletopics.toastmusters.com/topics/leadership/</loc>');
    expect(xml).toContain('<lastmod>2026-09-02</lastmod>');
  });

  it('robots allows all and points at the sitemap; llms.txt lists categories', () => {
    expect(html('/robots.txt')).toContain('User-agent: ClaudeBot');
    expect(html('/robots.txt')).toContain('Sitemap: https://www.tabletopics.toastmusters.com/sitemap.xml');
    expect(html('/llms.txt')).toContain('/topics/icebreakers/');
    expect(JSON.parse(html('/questions.json')).categories).toHaveLength(3);
  });

  it('footer renders the tools registry and cross-origin legal links', () => {
    const doc = html('/index.html');
    expect(doc).toContain('href="https://www.timer.toastmusters.com/"');
    expect(doc).toContain('https://www.timer.toastmusters.com/privacy');
  });
});

describe('assets', () => {
  const assets = buildAssets({ posthogKey: 'phc_test', posthogHost: 'https://e.simple-tech.app', timerAppUrl: 'https://www.timer.toastmusters.com/app' });

  it('inlines the lib modules into one browser file with no import/export left', () => {
    const js = assets['generator.js'];
    expect(js).not.toMatch(/^import\s/m);
    expect(js).not.toMatch(/^export\s/m);
    expect(js).toContain('function drawQuestion');
    expect(js).toContain('function todaySet');
    expect(js).toContain('function timerDeepLink');
    expect(js).toContain("'https://www.timer.toastmusters.com/app'");
    expect(js).not.toContain('__TIMER_APP_URL__');
  });

  it('substitutes PostHog placeholders', () => {
    expect(assets['analytics.js']).toContain("'phc_test'");
    expect(assets['analytics.js']).not.toContain('__POSTHOG_');
  });

  it('hashes names by content', () => {
    expect(hashedName('generator.js', 'abc')).toMatch(/^\/assets\/generator\.[0-9a-f]{8}\.js$/);
    expect(hashedName('generator.js', 'abc')).not.toBe(hashedName('generator.js', 'abd'));
  });

  it('parseDotEnv handles comments and quotes', () => {
    expect(parseDotEnv('# c\nA=1\nB="two words"\nC=\'x\'\n\nD\n')).toEqual({ A: '1', B: 'two words', C: 'x' });
  });
});

describe('build (end to end into a temp dir)', () => {
  it('writes pages, hashed assets and rejects an invalid bank', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tt-build-'));
    const q = join(dir, 'q.json');
    writeFileSync(q, JSON.stringify(bank));
    const dist = join(dir, 'dist');
    const r = build({ questionsFile: q, distDir: dist, env: { BUILD_DATE: '2026-09-02', VITE_PUBLIC_POSTHOG_KEY: '', SITE_ORIGIN: 'https://www.tabletopics-dev.toastmusters.com' } });
    expect(r.pages).toBe(11);
    expect(existsSync(join(dist, 'topics/humor'))).toBe(false);
    expect(existsSync(join(dist, 'topics/travel-places/index.html'))).toBe(true);
    const assetFiles = readdirSync(join(dist, 'assets'));
    expect(assetFiles.some((f) => /^generator\.[0-9a-f]{8}\.js$/.test(f))).toBe(true);
    expect(assetFiles.some((f) => /^content-pages\.[0-9a-f]{8}\.css$/.test(f))).toBe(true);
    const home = readFileSync(join(dist, 'index.html'), 'utf8');
    expect(home).toContain('https://www.tabletopics-dev.toastmusters.com/');
    const bad = structuredClone(bank);
    bad.categories[0].questions[0].text = 'no question mark';
    writeFileSync(q, JSON.stringify(bad));
    expect(() => build({ questionsFile: q, distDir: dist, env: {} })).toThrow(/problem/);
  });
});
