// The static guide pages in public/ are plain HTML, outside React, so nothing
// else checks the conventions they share: analytics on every page, Add to Zoom
// as the call to action, and every link into the web timer tracked.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const PUBLIC_DIR = path.resolve(__dirname, '../public');
const pages = readdirSync(PUBLIC_DIR).filter((f) => f.endsWith('.html'));
const read = (file) => readFileSync(path.join(PUBLIC_DIR, file), 'utf8');

describe('static pages', () => {
  it('finds the pages', () => {
    expect(pages.length).toBeGreaterThan(10);
  });

  it.each(pages)('%s loads site analytics', (file) => {
    expect(read(file)).toContain('<script src="/site-analytics.js" defer></script>');
  });

  it.each(pages)('%s links into the web timer only through a tracked CTA', (file) => {
    const untracked = (read(file).match(/<a [^>]*href="\/timer\/app"[^>]*>/g) || []).filter((tag) => !tag.includes('data-cta='));
    expect(untracked).toEqual([]);
  });

  it.each(pages.filter((f) => f !== '404.html'))('%s offers Add to Zoom, tracked', (file) => {
    expect(read(file)).toMatch(/<a [^>]*href="\/add-to-zoom"[^>]*data-cta="add_to_zoom"/);
  });
});
