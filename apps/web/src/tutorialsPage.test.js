// /tutorials is plain HTML in public/ with five videos in it. The static-page
// test covers analytics and CTAs; this one covers what is specific to the
// player page: every tutorial has its files, the playlist and the articles
// agree, the structured data names the same videos, and the home page's
// teaser cards point at tutorials that exist.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const PUBLIC_DIR = path.resolve(__dirname, '../public');
const page = readFileSync(path.join(PUBLIC_DIR, 'tutorials.html'), 'utf8');
const landing = readFileSync(path.resolve(__dirname, 'pages/Landing.jsx'), 'utf8');

const articleIds = [...page.matchAll(/<article id="([^"]+)" class="tut-video"/g)].map((m) => m[1]);
const playlistSlugs = [...page.matchAll(/<a class="tut-item[^"]*" href="#([^"]+)"/g)].map((m) => m[1]);

describe('tutorials page', () => {
  it('has the five tutorials, in order, with a matching playlist', () => {
    expect(articleIds).toEqual(['first-speech', 'display-modes', 'agenda', 'table-topics', 'report']);
    expect(playlistSlugs).toEqual(articleIds);
  });

  it.each(articleIds)('%s has its video and poster files', (slug) => {
    expect(existsSync(path.join(PUBLIC_DIR, 'video/tutorials', `${slug}.mp4`))).toBe(true);
    expect(existsSync(path.join(PUBLIC_DIR, 'video/tutorials', `${slug}-poster.jpg`))).toBe(true);
    expect(page).toContain(`src="/video/tutorials/${slug}.mp4"`);
  });

  it('shows only the first video until a script picks another, and keeps every transcript in the HTML', () => {
    const hidden = [...page.matchAll(/<article id="([^"]+)" class="tut-video" hidden/g)].map((m) => m[1]);
    expect(hidden).toEqual(articleIds.slice(1));
    expect([...page.matchAll(/<section id="[^"]+-tx" class="tut-tx">/g)]).toHaveLength(5);
  });

  it('describes each video with a VideoObject, transcript included', () => {
    const blocks = [...page.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
    const list = blocks.find((b) => b['@type'] === 'ItemList');
    const videos = list.itemListElement.map((e) => e.item);
    expect(videos.map((v) => v.url.split('#')[1])).toEqual(articleIds);
    videos.forEach((v) => {
      expect(v['@type']).toBe('VideoObject');
      expect(v.duration).toMatch(/^PT\d+S$/);
      expect(v.transcript.length).toBeGreaterThan(80);
      expect(v.contentUrl).toMatch(/^https:\/\/www\.toastmusters\.com\/video\/tutorials\/[a-z-]+\.mp4$/);
    });
  });

  it('is canonical at /tutorials and links the overview pages', () => {
    expect(page).toContain('<link rel="canonical" href="https://www.toastmusters.com/tutorials" />');
    expect(page).toContain('href="/toastmasters-timer-demo"');
    expect(page).toContain('href="/toastmasters-timer-zoom-demo"');
  });

  it("is what the home page's teaser cards link to", () => {
    const cards = [...landing.matchAll(/\{ slug: '([^']+)', n: '\d'/g)].map((m) => m[1]);
    expect(cards).toHaveLength(3);
    cards.forEach((slug) => expect(articleIds).toContain(slug));
  });
});
