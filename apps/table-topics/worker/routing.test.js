import { describe, it, expect, vi } from 'vitest';
import worker, { basePathFor } from './index.js';

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
const get = (url) => new Request(url, { headers: { host: new URL(url).host } });
const PROD = { ROOT_ORIGIN: 'https://www.toastmusters.com' };

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

describe('the old tabletopics.toastmusters.com host', () => {
  it.each([
    ['https://www.tabletopics.toastmusters.com/', 'https://www.toastmusters.com/tabletopics/'],
    ['https://tabletopics.toastmusters.com/topics/travel-places/?q=x', 'https://www.toastmusters.com/tabletopics/topics/travel-places/?q=x'],
    ['https://www.tabletopics.toastmusters.com/questions.json', 'https://www.toastmusters.com/tabletopics/questions.json'],
  ])('301s %s to the same page on www.toastmusters.com, in one hop', async (from, to) => {
    const env = makeEnv([], PROD);
    const res = await worker.fetch(get(from), env);
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe(to);
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it('keeps serving the dev host itself while dev has no ROOT_ORIGIN', async () => {
    const apex = await worker.fetch(get('https://tabletopics-dev.toastmusters.com/today/'), makeEnv());
    expect(apex.headers.get('location')).toBe('https://www.tabletopics-dev.toastmusters.com/today/');

    const root = await worker.fetch(get('https://www.tabletopics-dev.toastmusters.com/today/'), makeEnv());
    expect(root.headers.get('location')).toBe('https://www.tabletopics-dev.toastmusters.com/tabletopics/today/');

    const page = await worker.fetch(
      get('https://www.tabletopics-dev.toastmusters.com/tabletopics/today/'),
      makeEnv(['/tabletopics/today/'])
    );
    expect(page.status).toBe(200);
  });

  // wrangler dev rewrites Host to the first route; http must not redirect off-site.
  it('does not send local http requests to production', async () => {
    const res = await worker.fetch(get('http://tabletopics.toastmusters.com/tabletopics/'), makeEnv(['/tabletopics/'], PROD));
    expect(res.status).toBe(200);
  });
});

describe('www.toastmusters.com/tabletopics (through the timer Worker binding)', () => {
  it('serves a page with security headers', async () => {
    const res = await worker.fetch(get('https://www.toastmusters.com/tabletopics/today/'), makeEnv(['/tabletopics/today/'], PROD));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self' https://e.simple-tech.app");
    expect(res.headers.get('content-security-policy')).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(res.headers.get('content-security-policy')).toContain('https://fonts.googleapis.com');
    expect(res.headers.get('content-security-policy')).toContain('https://fonts.gstatic.com');
    expect(res.headers.get('content-security-policy')).toContain('https://static.cloudflareinsights.com');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('strict-transport-security')).toContain('max-age=31536000');
    expect(res.headers.get('x-robots-tag')).toBeNull();
  });

  it('serves its own 404 page with a 404 status', async () => {
    const res = await worker.fetch(get('https://www.toastmusters.com/tabletopics/nope'), makeEnv(['/tabletopics/404.html'], PROD));
    expect(res.status).toBe(404);
    expect(res.headers.get('x-asset-path')).toBe('/tabletopics/404.html');
    expect(await res.text()).toBe('content of /tabletopics/404.html');
  });

  it('caches hashed assets immutably and questions.json for an hour', async () => {
    const env = makeEnv(['/tabletopics/assets/generator.abc12345.js', '/tabletopics/questions.json'], PROD);
    const a = await worker.fetch(get('https://www.toastmusters.com/tabletopics/assets/generator.abc12345.js'), env);
    expect(a.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const q = await worker.fetch(get('https://www.toastmusters.com/tabletopics/questions.json'), env);
    expect(q.headers.get('cache-control')).toBe('public, max-age=3600');
  });

  it('marks a dev host noindex', async () => {
    const res = await worker.fetch(
      get('https://www.tabletopics-dev.toastmusters.com/tabletopics/'),
      makeEnv(['/tabletopics/'])
    );
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  });
});
