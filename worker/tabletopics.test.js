import { describe, it, expect, vi } from 'vitest';
import worker from './index.js';
import { basePathFor, legacyTableTopicsTarget } from './tabletopics.js';

function makeEnv(presentPaths = [], vars = {}) {
  const present = new Set(presentPaths);
  return {
    ...vars,
    ASSETS: {
      fetch: vi.fn((request) => {
        const { pathname } = new URL(request.url);
        const found = present.has(pathname);
        return Promise.resolve(
          new Response(found ? `content of ${pathname}` : 'not found', {
            status: found ? 200 : 404,
            headers: { 'x-asset-path': pathname, 'content-type': 'text/html' },
          })
        );
      }),
    },
  };
}
const ctx = { waitUntil: () => {} };
const get = (url) => new Request(url, { headers: { host: new URL(url).host } });
const PROD = { ROOT_ORIGIN: 'https://www.toastmusters.com' };
const DEV = { ROOT_ORIGIN: 'https://www.timer-dev.toastmusters.com' };

describe('basePathFor', () => {
  it.each([
    ['/', '/tabletopics/'],
    ['/topics/humor/', '/tabletopics/topics/humor/'],
    ['/tabletopics/today/', '/tabletopics/today/'],
    ['/tabletopics', '/tabletopics'],
  ])('%s -> %s', (from, to) => {
    expect(basePathFor(from)).toBe(to);
  });
});

describe('legacyTableTopicsTarget', () => {
  it('keeps the query', () => {
    expect(legacyTableTopicsTarget(new URL('https://tabletopics.toastmusters.com/topics/x/?q=1'), 'https://www.toastmusters.com')).toBe(
      'https://www.toastmusters.com/tabletopics/topics/x/?q=1'
    );
  });
});

describe('the old tabletopics.toastmusters.com hosts', () => {
  it.each([
    [PROD, 'https://www.tabletopics.toastmusters.com/', 'https://www.toastmusters.com/tabletopics/'],
    [PROD, 'https://tabletopics.toastmusters.com/topics/travel-places/?q=x', 'https://www.toastmusters.com/tabletopics/topics/travel-places/?q=x'],
    [PROD, 'https://www.tabletopics.toastmusters.com/questions.json', 'https://www.toastmusters.com/tabletopics/questions.json'],
    [DEV, 'https://tabletopics-dev.toastmusters.com/today/', 'https://www.timer-dev.toastmusters.com/tabletopics/today/'],
  ])('301s %s %s to the same page on the main site, in one hop', async (vars, from, to) => {
    const env = makeEnv([], vars);
    const res = await worker.fetch(get(from), env, ctx);
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe(to);
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  // wrangler dev rewrites Host to the first route; http must not redirect off-site.
  it('does not send local http requests off-site', async () => {
    const res = await worker.fetch(get('http://tabletopics.toastmusters.com/tabletopics/'), makeEnv(['/tabletopics/'], PROD), ctx);
    expect(res.status).toBe(200);
  });
});

describe('www.toastmusters.com/tabletopics', () => {
  it('serves a page with security headers', async () => {
    const res = await worker.fetch(get('https://www.toastmusters.com/tabletopics/today/'), makeEnv(['/tabletopics/today/'], PROD), ctx);
    expect(res.status).toBe(200);
    const csp = res.headers.get('content-security-policy');
    expect(csp).toContain("script-src 'self' https://e.simple-tech.app");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain('https://fonts.googleapis.com');
    expect(csp).toContain('https://fonts.gstatic.com');
    expect(csp).toContain('https://static.cloudflareinsights.com');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('strict-transport-security')).toContain('max-age=31536000');
    expect(res.headers.get('x-robots-tag')).toBeNull();
  });

  it('serves its own 404 page with a 404 status', async () => {
    const res = await worker.fetch(get('https://www.toastmusters.com/tabletopics/nope'), makeEnv(['/tabletopics/404.html'], PROD), ctx);
    expect(res.status).toBe(404);
    expect(res.headers.get('x-asset-path')).toBe('/tabletopics/404.html');
  });

  it('caches hashed assets immutably and questions.json for an hour', async () => {
    const env = makeEnv(['/tabletopics/assets/generator.abc12345.js', '/tabletopics/questions.json'], PROD);
    const a = await worker.fetch(get('https://www.toastmusters.com/tabletopics/assets/generator.abc12345.js'), env, ctx);
    expect(a.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const q = await worker.fetch(get('https://www.toastmusters.com/tabletopics/questions.json'), env, ctx);
    expect(q.headers.get('cache-control')).toBe('public, max-age=3600');
  });

  it('marks the dev host noindex', async () => {
    const res = await worker.fetch(get('https://www.timer-dev.toastmusters.com/tabletopics/'), makeEnv(['/tabletopics/'], DEV), ctx);
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  });
});
