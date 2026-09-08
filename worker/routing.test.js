import { describe, it, expect, vi } from 'vitest';
import worker from './index.js';

// Minimal ASSETS stub. Returns 200 for paths we declare as present, 404
// otherwise, and echoes the resolved asset path back in a header so tests can
// assert which file the Worker decided to serve.
function makeEnv(presentPaths = []) {
  const present = new Set(presentPaths);
  return {
    ASSETS: {
      fetch: vi.fn((request) => {
        const { pathname } = new URL(request.url);
        const found = present.has(pathname);
        return Promise.resolve(
          new Response(found ? `content of ${pathname}` : 'not found', {
            status: found ? 200 : 404,
            headers: { 'x-asset-path': pathname },
          })
        );
      }),
    },
  };
}

const ctx = { waitUntil: () => {} };

function get(url, { host, method = 'GET' } = {}) {
  const parsed = new URL(url);
  return new Request(url, {
    method,
    headers: { host: host ?? parsed.host },
  });
}

describe('canonical host redirect', () => {
  it('301s the bare apex host to www, preserving path and query', async () => {
    const res = await worker.fetch(
      get('https://timer.simple-tech.app/toastmasters-timing-chart?ref=x'),
      makeEnv(),
      ctx
    );

    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe(
      'https://www.timer.simple-tech.app/toastmasters-timing-chart?ref=x'
    );
  });

  it('301s the dev apex host to its own www counterpart', async () => {
    const res = await worker.fetch(
      get('https://timer-dev.simple-tech.app/'),
      makeEnv(),
      ctx
    );

    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('https://www.timer-dev.simple-tech.app/');
  });

  it('301s the new domain apex to its own www host, preserving path and query', async () => {
    const res = await worker.fetch(
      get('https://timer.toastmusters.com/toastmasters-timing-chart?ref=x'),
      makeEnv(),
      ctx
    );

    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe(
      'https://www.timer.toastmusters.com/toastmasters-timing-chart?ref=x'
    );
  });

  it('301s the new dev apex to its own www host', async () => {
    const res = await worker.fetch(get('https://timer-dev.toastmusters.com/'), makeEnv(), ctx);

    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('https://www.timer-dev.toastmusters.com/');
  });

  it('301s the parked bare root toastmusters.com to www', async () => {
    const res = await worker.fetch(get('https://toastmusters.com/'), makeEnv(), ctx);

    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('https://www.toastmusters.com/');
  });

  // Dual-serve (docs/DOMAIN_MIGRATION.md): the old www host keeps serving its
  // own content and must NOT redirect to the new domain until Phase 4.
  it('does not redirect the old www host to the new domain', async () => {
    const env = makeEnv(['/index.html']);
    const res = await worker.fetch(get('https://www.timer.simple-tech.app/'), env, ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });

  // The redirect must never manufacture www.zoom.timer.simple-tech.app — that
  // host does not exist and every Zoom-registered URL depends on the zoom
  // subdomain resolving directly.
  it.each([
    'https://www.timer.simple-tech.app/',
    'https://zoom.timer.simple-tech.app/',
    'https://zoom.timer-dev.simple-tech.app/',
    'https://www.timer-dev.simple-tech.app/',
    'https://www.timer.toastmusters.com/',
    'https://zoom.timer.toastmusters.com/',
    'https://zoom.timer-dev.toastmusters.com/',
    'https://www.timer-dev.toastmusters.com/',
    'https://www.toastmusters.com/',
    'http://localhost:8787/',
    'https://toastmaster-timer.workers.dev/',
  ])('does not redirect %s', async (url) => {
    const env = makeEnv(['/index.html', '/zoom/index.html']);
    const res = await worker.fetch(get(url), env, ctx);

    expect(res.status).not.toBe(301);
    expect(res.headers.get('location')).toBeNull();
  });

  // `wrangler dev` rewrites both the request URL and the Host header to the
  // first configured route, so the apex host appears on every local request.
  // Only the http scheme distinguishes it from production — without that
  // guard, `npm run cf:dev` bounces every request to the live site.
  it('does not redirect local wrangler dev traffic', async () => {
    const env = makeEnv(['/index.html']);
    const res = await worker.fetch(
      new Request('http://timer.simple-tech.app/', {
        headers: { host: 'timer.simple-tech.app' },
      }),
      env,
      ctx
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });

  it('handles the Zoom webhook before redirecting, so POST bodies survive', async () => {
    // A 301 on this route would strip the body and break signature
    // verification. The webhook must be reached even on the apex host.
    const res = await worker.fetch(
      new Request('https://timer.simple-tech.app/api/zoom/webhook', {
        method: 'POST',
        headers: { host: 'timer.simple-tech.app', 'content-type': 'application/json' },
        body: JSON.stringify({ event: 'endpoint.url_validation', payload: {} }),
      }),
      makeEnv(),
      ctx
    );

    expect(res.status).not.toBe(301);
  });
});

describe('404 handling', () => {
  it('serves the SPA shell with 200 for real app routes', async () => {
    const env = makeEnv(['/index.html']);

    for (const path of ['/', '/app', '/oauth/redirect']) {
      const res = await worker.fetch(
        get(`https://www.timer.simple-tech.app${path}`),
        env,
        ctx
      );
      expect(res.status, `${path} should be 200`).toBe(200);
      expect(res.headers.get('x-asset-path')).toBe('/index.html');
    }
  });

  it('returns a real 404 for unknown paths instead of a soft 404', async () => {
    const env = makeEnv(['/index.html', '/404.html']);
    const res = await worker.fetch(
      get('https://www.timer.simple-tech.app/does-not-exist'),
      env,
      ctx
    );

    expect(res.status).toBe(404);
    expect(res.headers.get('x-asset-path')).toBe('/404.html');
  });

  it('still serves existing static content pages', async () => {
    const env = makeEnv(['/toastmasters-timing-chart.html', '/404.html']);
    // html_handling resolves the clean URL, so ASSETS answers 200 directly.
    env.ASSETS.fetch = vi.fn(() =>
      Promise.resolve(new Response('chart', { status: 200 }))
    );

    const res = await worker.fetch(
      get('https://www.timer.simple-tech.app/toastmasters-timing-chart'),
      env,
      ctx
    );

    expect(res.status).toBe(200);
  });

  it('keeps the Zoom SPA fallback permissive for deep links', async () => {
    const env = makeEnv(['/zoom/index.html']);
    const res = await worker.fetch(
      get('https://zoom.timer.simple-tech.app/some/zoom/deep/link'),
      env,
      ctx
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('x-asset-path')).toBe('/zoom/index.html');
  });
});

describe('robots.txt', () => {
  it('serves a plain-text disallow on the zoom subdomain', async () => {
    const res = await worker.fetch(
      get('https://zoom.timer.simple-tech.app/robots.txt'),
      makeEnv(),
      ctx
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toContain('Disallow: /');
  });

  it('leaves the root robots.txt to static assets', async () => {
    const env = makeEnv(['/robots.txt']);
    const res = await worker.fetch(
      get('https://www.timer.simple-tech.app/robots.txt'),
      env,
      ctx
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('x-asset-path')).toBe('/robots.txt');
  });
});

describe('indexing headers', () => {
  it('marks the OAuth callback noindex', async () => {
    const env = makeEnv(['/index.html']);
    const res = await worker.fetch(
      get('https://www.timer.simple-tech.app/oauth/redirect'),
      env,
      ctx
    );

    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  });

  it('does not mark ordinary pages noindex', async () => {
    const env = makeEnv(['/index.html']);
    const res = await worker.fetch(
      get('https://www.timer.simple-tech.app/'),
      env,
      ctx
    );

    expect(res.headers.get('x-robots-tag')).toBeNull();
  });
});

describe('the Zoom identity endpoint is reachable from every host', () => {
  const CLIENT_SECRET = 'routing-test-client-secret';

  function post(url, { host, body = {} } = {}) {
    const parsed = new URL(url);
    return new Request(url, {
      method: 'POST',
      headers: { host: host ?? parsed.host, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  const env = (assets = []) => ({ ...makeEnv(assets), ZOOM_CLIENT_SECRET: CLIENT_SECRET });

  // The Zoom app is served from zoom.<domain>, where every unmatched path is
  // rewritten to the SPA shell. The endpoint has to be matched before that or
  // the app would get HTML back when it asks who the user is.
  it('answers on the zoom subdomain instead of falling through to the SPA', async () => {
    const res = await worker.fetch(
      post('https://zoom.timer.simple-tech.app/api/zoom/session'),
      env(['/zoom/index.html']),
      ctx
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ identified: false, isGuest: false });
  });

  // A 301 drops the POST body, taking the app context with it.
  it('is not redirected away from the bare apex host', async () => {
    const res = await worker.fetch(
      post('https://timer.simple-tech.app/api/zoom/session'),
      env(),
      ctx
    );

    expect(res.status).toBe(200);
  });

  it('answers on the www host too', async () => {
    const res = await worker.fetch(
      post('https://www.timer.simple-tech.app/api/zoom/session'),
      env(),
      ctx
    );

    expect(res.status).toBe(200);
  });

  it('never lets a per-user answer reach a cache', async () => {
    const res = await worker.fetch(
      post('https://zoom.timer.simple-tech.app/api/zoom/session'),
      env(),
      ctx
    );

    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });
});

describe('/oauth/redirect: sign-in callback vs Marketplace install', () => {
  const authEnv = () => ({
    ...makeEnv(['/index.html']),
    SESSION_SIGNING_KEY: 'k',
    ZOOM_CLIENT_ID: 'cid',
    ZOOM_CLIENT_SECRET: 'sec',
    WEB_ORIGIN: 'https://www.timer.simple-tech.app',
  });

  // The Marketplace "Add" flow lands here with a code and no state. It must
  // still get the SPA's install-success page, and never a session.
  it('serves the SPA for an install callback without state', async () => {
    const res = await worker.fetch(get('https://www.timer.simple-tech.app/oauth/redirect?code=abc'), authEnv(), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-asset-path')).toBe('/index.html');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  });

  it('serves the SPA for a state nobody signed', async () => {
    const res = await worker.fetch(get('https://www.timer.simple-tech.app/oauth/redirect?code=abc&state=forged.sig'), authEnv(), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-asset-path')).toBe('/index.html');
  });

  it('starts sign-in from /api/auth/zoom/start and completes it on the callback', async () => {
    const env = authEnv();
    const started = await worker.fetch(get('https://www.timer.simple-tech.app/api/auth/zoom/start?returnTo=%2Fapp'), env, ctx);
    expect(started.status).toBe(302);
    const location = new URL(started.headers.get('location'));
    expect(location.hostname).toBe('zoom.us');
    const nonce = started.headers.get('set-cookie').match(/tt_oauth=([^;]+)/)[1];
    const state = location.searchParams.get('state');

    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url) =>
      String(url).includes('/oauth/token')
        ? new Response(JSON.stringify({ access_token: 'at' }), { status: 200 })
        : new Response(JSON.stringify({ id: 'zoom-user' }), { status: 200 })
    );
    try {
      const cb = new Request(`https://www.timer.simple-tech.app/oauth/redirect?code=c&state=${encodeURIComponent(state)}`, {
        headers: { host: 'www.timer.simple-tech.app', cookie: `tt_oauth=${nonce}` },
      });
      const res = await worker.fetch(cb, env, ctx);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('https://www.timer.simple-tech.app/app');
      expect(res.headers.get('set-cookie')).toMatch(/tt_session=/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('routes /account and /billing/* to the SPA shell', async () => {
    for (const path of ['/account', '/billing/success', '/billing/cancel']) {
      const res = await worker.fetch(get(`https://www.timer.simple-tech.app${path}`), makeEnv(['/index.html']), ctx);
      expect(res.status).toBe(200);
      expect(res.headers.get('x-asset-path')).toBe('/index.html');
    }
  });
});
