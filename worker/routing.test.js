import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import worker from './index.js';
import { FLAG_FALLBACKS } from './flags.js';

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

// An ExecutionContext that keeps its waitUntil promises, for routes whose work
// continues after the response (zoom-webhook.test.js uses the same shape).
function createCtx() {
  const promises = [];
  return {
    waitUntil: (p) => promises.push(p),
    pending: () => promises.length,
    _settle: () => Promise.allSettled(promises),
  };
}

// The Map-backed KV the contact capture writes into.
function makeKv() {
  const store = new Map();
  return {
    store,
    get: async (key, type) => {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    put: async (key, value) => { store.set(key, value); },
  };
}

function get(url, { host, method = 'GET', cookie } = {}) {
  const parsed = new URL(url);
  const headers = { host: host ?? parsed.host };
  if (cookie) headers.cookie = cookie;
  return new Request(url, { method, headers });
}

const setCookies = (res) => res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie')].filter(Boolean);

// The "approved before" mark the install landing sets (worker/reconnect.js).
const APPROVED_SET_COOKIE = /^tt_approved=1; Path=\/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax$/;

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

  // The old www host's public pages do move to the new domain, but only with
  // ROOT_ORIGIN set; see "the old simple-tech web host's public pages move to
  // www.toastmusters.com" below. Without it (these tests) nothing redirects.

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

describe('the old toastmusters.com timer hosts move to www.toastmusters.com', () => {
  const prod = () => ({ ...makeEnv(['/index.html']), ROOT_ORIGIN: 'https://www.toastmusters.com' });

  it.each([
    ['https://timer.toastmusters.com/', 'https://www.toastmusters.com/'],
    ['https://www.timer.toastmusters.com/', 'https://www.toastmusters.com/'],
    ['https://www.timer.toastmusters.com/toastmasters-timing-chart', 'https://www.toastmusters.com/toastmasters-timing-chart'],
    ['https://www.timer.toastmusters.com/app?role=Table%20Topics%20Speech&name=Q', 'https://www.toastmusters.com/timer/app?role=Table%20Topics%20Speech&name=Q'],
    ['https://www.timer.toastmusters.com/web', 'https://www.toastmusters.com/timer/app'],
    ['https://www.timer.toastmusters.com/r/ABCDEFGHJKMNPQRS', 'https://www.toastmusters.com/r/ABCDEFGHJKMNPQRS'],
  ])('301s %s to %s in one hop', async (from, to) => {
    const env = prod();
    const res = await worker.fetch(get(from), env, ctx);

    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe(to);
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it('never redirects an API call, whose POST body a 301 would drop', async () => {
    const env = prod();
    const res = await worker.fetch(get('https://www.timer.toastmusters.com/api/stats'), env, ctx);

    expect(res.status).not.toBe(301);
  });

  // zoom.timer.toastmusters.com may become the Zoom app's home; a cached 301
  // there would outlive any change of plan.
  it.each([
    'https://www.timer.simple-tech.app/timer/app',
    'https://zoom.timer.simple-tech.app/',
    'https://zoom.timer.toastmusters.com/',
    'https://www.toastmusters.com/',
  ])('leaves %s alone', async (url) => {
    const res = await worker.fetch(get(url), prod(), ctx);

    expect(res.status).not.toBe(301);
  });

  it('does nothing without ROOT_ORIGIN (dev) or over http (wrangler dev)', async () => {
    const dev = await worker.fetch(get('https://www.timer.toastmusters.com/'), makeEnv(['/index.html']), ctx);
    const local = await worker.fetch(get('http://www.timer.toastmusters.com/'), prod(), ctx);

    expect(dev.status).toBe(200);
    expect(local.status).toBe(200);
  });
});

// The old simple-tech.app host (#98). Its public pages exist on the main site
// too, so serving them here makes Google pick this host as canonical. Its app
// routes stay: sign-in, Stripe and the Zoom install all come back to WEB_ORIGIN.
describe("the old simple-tech web host's public pages move to www.toastmusters.com", () => {
  const prod = () => ({ ...makeEnv(['/index.html']), ROOT_ORIGIN: 'https://www.toastmusters.com' });
  const dev = () => ({ ...makeEnv(['/index.html']), ROOT_ORIGIN: 'https://www.timer-dev.toastmusters.com' });

  it.each([
    // The landing page. The bare host takes one hop here, not two (apex to
    // www, then off-site).
    ['https://timer.simple-tech.app/', 'https://www.toastmusters.com/', prod],
    ['https://www.timer.simple-tech.app/?utm=x', 'https://www.toastmusters.com/?utm=x', prod],
    ['https://www.timer-dev.simple-tech.app/', 'https://www.timer-dev.toastmusters.com/', dev],
    ['https://timer-dev.simple-tech.app/', 'https://www.timer-dev.toastmusters.com/', dev],
    // The guides and the video pages. A trailing slash is dropped.
    ['https://www.timer.simple-tech.app/toastmasters-timing-chart', 'https://www.toastmusters.com/toastmasters-timing-chart', prod],
    ['https://www.timer.simple-tech.app/best-toastmasters-timer-apps/', 'https://www.toastmusters.com/best-toastmasters-timer-apps', prod],
    ['https://www.timer.simple-tech.app/toastmasters-timer-demo?t=30', 'https://www.toastmusters.com/toastmasters-timer-demo?t=30', prod],
    ['https://timer.simple-tech.app/toastmasters-timing-chart', 'https://www.toastmusters.com/toastmasters-timing-chart', prod],
    ['https://www.timer-dev.simple-tech.app/toastmasters-timing-chart', 'https://www.timer-dev.toastmusters.com/toastmasters-timing-chart', dev],
    // The Zoom listing's pages, which index.js serves from /zoom/*.html.
    ['https://www.timer.simple-tech.app/privacy', 'https://www.toastmusters.com/privacy', prod],
    ['https://www.timer.simple-tech.app/support', 'https://www.toastmusters.com/support', prod],
    ['https://www.timer.simple-tech.app/terms-of-use', 'https://www.toastmusters.com/terms-of-use', prod],
    ['https://www.timer.simple-tech.app/documentation', 'https://www.toastmusters.com/documentation', prod],
    ['https://www.timer-dev.simple-tech.app/privacy', 'https://www.timer-dev.toastmusters.com/privacy', dev],
    // Table Topics, with its path exactly as asked.
    ['https://www.timer.simple-tech.app/tabletopics/topics/', 'https://www.toastmusters.com/tabletopics/topics/', prod],
    ['https://www.timer.simple-tech.app/tabletopics', 'https://www.toastmusters.com/tabletopics', prod],
    ['https://timer.simple-tech.app/tabletopics/today/?q=1', 'https://www.toastmusters.com/tabletopics/today/?q=1', prod],
    ['https://www.timer-dev.simple-tech.app/tabletopics/', 'https://www.timer-dev.toastmusters.com/tabletopics/', dev],
  ])('301s %s to %s in one hop', async (from, to, makeEnvFor) => {
    const env = makeEnvFor();
    const res = await worker.fetch(get(from), env, ctx);

    // A bare / depends on the reconnect mark, so its 301 is never cached;
    // every other page is cacheable for a day.
    const { pathname, search } = new URL(from);
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe(to);
    expect(res.headers.get('cache-control')).toBe(pathname === '/' && !search ? 'no-store' : 'public, max-age=86400');
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  // The app on the old host is not a public page: the apex still goes to the
  // old www host, and the app is served from there.
  it('still sends an app path on the bare host to the old www host', async () => {
    const env = prod();
    const res = await worker.fetch(get('https://timer.simple-tech.app/timer/app'), env, ctx);

    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('https://www.timer.simple-tech.app/timer/app');
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it('serves the web timer on the old www host as before', async () => {
    const res = await worker.fetch(get('https://www.timer.simple-tech.app/timer/app'), prod(), ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get('x-asset-path')).toBe('/index.html');
  });

  // Sign-in, Stripe and the Zoom install all come back to WEB_ORIGIN on this
  // host, so every app route stays and answers as it did before the move. A
  // missed one would break the web timer here, or the install. Each row is the
  // status and Location this host gave before #98, and none points at
  // ROOT_ORIGIN. /app is an app route that was already redirected on this host:
  // to its new path, still here.
  it.each([
    ['/timer/app', 200, null],
    ['/oauth/redirect?code=x', 302, 'https://www.timer.simple-tech.app/oauth/redirect?welcome=new'],
    ['/oauth/redirect?welcome=new', 200, null],
    ['/reconnect', 200, null],
    ['/account', 200, null],
    ['/billing/success', 200, null],
    ['/billing/cancel', 200, null],
    ['/club/admin', 200, null],
    ['/club/manage', 200, null],
    ['/pro/ABC', 200, null],
    ['/r/ABCDEFGHJKMNPQRS', 404, null], // no KV bound here; it still reached the handler
    ['/zoom/', 200, null],
    ['/zoom/privacy.html', 200, null],
    ['/add-to-zoom', 302, 'https://marketplace.zoom.us/apps/sWHvcm4YShyr6SXQQI8DFw'],
    ['/app', 301, 'https://www.timer.simple-tech.app/timer/app'],
    ['/web', 302, 'https://www.timer.simple-tech.app/timer/app'],
    ['/timer', 302, 'https://www.timer.simple-tech.app/'],
    ['/assets/index.js', 200, null],
    ['/robots.txt', 200, null],
    ['/sitemap.xml', 200, null],
    ['/llms.txt', 200, null],
  ])('keeps %s on the old www host: %i, location %s', async (path, status, location) => {
    const env = {
      ...makeEnv(['/index.html', '/zoom/index.html', '/zoom/privacy.html', '/assets/index.js', '/robots.txt', '/sitemap.xml', '/llms.txt']),
      ROOT_ORIGIN: 'https://www.toastmusters.com',
    };
    const res = await worker.fetch(get(`https://www.timer.simple-tech.app${path}`), env, ctx);

    expect(res.status).toBe(status);
    expect(res.headers.get('location')).toBe(location);
    expect(res.headers.get('cache-control')).not.toBe('public, max-age=86400');
  });

  // The list of moved pages is kept by hand (worker/old-web-host.js) and the
  // sitemap is generated. A page that is in the sitemap but not in the list
  // stays served here, and Google keeps picking this host as its canonical.
  it('moves every page the sitemap lists', async () => {
    const sitemap = readFileSync(new URL('../apps/web/public/sitemap.xml', import.meta.url), 'utf8');
    const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
    expect(locs.length).toBeGreaterThan(0);

    for (const loc of locs) {
      const { pathname, search } = new URL(loc);
      const env = prod();
      const res = await worker.fetch(get(`https://www.timer.simple-tech.app${pathname}${search}`), env, ctx);

      expect(res.status, `${pathname} should be moved`).toBe(301);
      expect(res.headers.get('location'), pathname).toBe(loc);
      expect(env.ASSETS.fetch, pathname).not.toHaveBeenCalled();
    }
  });

  // A 301 on a POST would drop its body; the API routes are matched first.
  it('never redirects an API call on the old www host', async () => {
    const res = await worker.fetch(
      new Request('https://www.timer.simple-tech.app/api/zoom/webhook', {
        method: 'POST',
        headers: { host: 'www.timer.simple-tech.app', 'content-type': 'application/json' },
        body: JSON.stringify({ event: 'endpoint.url_validation', payload: {} }),
      }),
      prod(),
      ctx
    );

    expect(res.status).not.toBe(301);
  });

  // The Zoom app lives on zoom.<domain>, and www.toastmusters.com is where the
  // page moves to: a 301 from either would break the app or loop.
  it.each([
    'https://zoom.timer.simple-tech.app/',
    'https://zoom.timer-dev.simple-tech.app/',
    'https://www.toastmusters.com/',
  ])('leaves %s alone', async (url) => {
    const res = await worker.fetch(get(url), prod(), ctx);

    expect(res.status).not.toBe(301);
  });

  it('does nothing without ROOT_ORIGIN (dev) or over http (wrangler dev)', async () => {
    const noRoot = await worker.fetch(get('https://www.timer.simple-tech.app/'), makeEnv(['/index.html']), ctx);
    const local = await worker.fetch(get('http://www.timer.simple-tech.app/'), prod(), ctx);

    expect(noRoot.status).toBe(200);
    expect(local.status).toBe(200);
  });
});

describe('/add-to-zoom', () => {
  it("sends people to this deployment's Zoom install screen", async () => {
    const env = { ...makeEnv([]), ZOOM_CLIENT_ID: 'client-123', WEB_ORIGIN: 'https://www.timer.simple-tech.app' };
    const res = await worker.fetch(get('https://www.toastmusters.com/add-to-zoom'), env, ctx);

    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location'));
    expect(location.origin + location.pathname).toBe('https://zoom.us/oauth/authorize');
    expect(location.searchParams.get('client_id')).toBe('client-123');
    expect(location.searchParams.get('redirect_uri')).toBe('https://www.timer.simple-tech.app/oauth/redirect');
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('falls back to the Marketplace listing when no install link is configured', async () => {
    const res = await worker.fetch(get('https://www.toastmusters.com/add-to-zoom'), makeEnv([]), ctx);

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://marketplace.zoom.us/apps/sWHvcm4YShyr6SXQQI8DFw');
  });
});

describe('/tabletopics is served from this Worker\'s own assets', () => {
  const env = () => makeEnv(['/index.html', '/404.html', '/tabletopics/', '/tabletopics/404.html', '/tabletopics/today/']);

  it.each(['/tabletopics/', '/tabletopics/today/'])('serves %s with the Table Topics CSP', async (path) => {
    const res = await worker.fetch(get(`https://www.toastmusters.com${path}`), env(), ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self' https://e.simple-tech.app");
    expect(res.headers.get('content-security-policy')).not.toContain("'unsafe-inline' https://e.simple-tech.app");
  });

  it('answers a missing page with its own 404, never the timer shell', async () => {
    const res = await worker.fetch(get('https://www.toastmusters.com/tabletopics/nope'), env(), ctx);

    expect(res.status).toBe(404);
    expect(res.headers.get('x-asset-path')).toBe('/tabletopics/404.html');
  });

  it('leaves look-alike paths and the Zoom host alone', async () => {
    const e = env();
    const lookalike = await worker.fetch(get('https://www.toastmusters.com/tabletopics-old'), e, ctx);
    const zoom = await worker.fetch(get('https://zoom.timer.simple-tech.app/tabletopics/'), e, ctx);

    expect(lookalike.headers.get('x-asset-path')).toBe('/404.html');
    expect(zoom.headers.get('content-security-policy')).toContain('zoom');
  });
});

describe('the web timer moved from /app to /timer/app', () => {
  it('301s /app to /timer/app and keeps the query', async () => {
    const env = makeEnv(['/index.html']);
    const res = await worker.fetch(
      get('https://www.timer.simple-tech.app/app?role=Table%20Topics%20Speech&name=Test'),
      env,
      ctx
    );

    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe(
      'https://www.timer.simple-tech.app/timer/app?role=Table%20Topics%20Speech&name=Test'
    );
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it('sends /web straight to /timer/app in one hop', async () => {
    const env = makeEnv(['/index.html']);
    const res = await worker.fetch(get('https://www.timer.simple-tech.app/web'), env, ctx);

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://www.timer.simple-tech.app/timer/app');
  });

  // /timer is held for a timer landing page should / become a suite home; a
  // 302 is not cached, so the URL stays free to change its answer later.
  it.each(['/timer', '/timer/'])('points %s at the landing page with a 302', async (path) => {
    const env = makeEnv(['/index.html']);
    const res = await worker.fetch(get(`https://www.toastmusters.com${path}`), env, ctx);

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://www.toastmusters.com/');
  });
});

describe('404 handling', () => {
  it('serves the SPA shell with 200 for real app routes', async () => {
    const env = makeEnv(['/index.html']);

    for (const path of ['/', '/timer/app', '/oauth/redirect', '/club/admin', '/club/manage', '/reconnect', '/reconnect/']) {
      const res = await worker.fetch(
        get(`https://www.timer.simple-tech.app${path}`),
        env,
        ctx
      );
      expect(res.status, `${path} should be 200`).toBe(200);
      expect(res.headers.get('x-asset-path')).toBe('/index.html');
    }
  });

  // The officer's shareable activation link. Its tail is a club code, so the
  // set of valid paths cannot be enumerated the way SPA_ROUTES enumerates the
  // rest — it has to match on the prefix.
  it('serves the root SPA shell for /pro/<code>', async () => {
    const env = makeEnv(['/index.html', '/404.html']);

    for (const path of ['/pro/DTSP-7K2QM9', '/pro/dtsp7k2qm9']) {
      const res = await worker.fetch(get(`https://www.timer.simple-tech.app${path}`), env, ctx);
      expect(res.status, `${path} should be 200`).toBe(200);
      expect(res.headers.get('x-asset-path')).toBe('/index.html');
    }

    // Bare /pro is not a route; only a code under it is.
    expect((await worker.fetch(get('https://www.timer.simple-tech.app/pro'), env, ctx)).status).toBe(404);
  });

  // The club logo is an API route, not an asset the SPA owns: it must never
  // fall through to the shell, or the badge compositor would be handed HTML to
  // decode as an image.
  it('never serves the SPA shell for /api/club-assets/*', async () => {
    const env = { ...makeEnv(['/index.html', '/404.html']), CARD_ASSETS: undefined };

    const res = await worker.fetch(
      get('https://www.timer.simple-tech.app/api/club-assets/club-1/abc.png'),
      env,
      ctx
    );

    // 503 because no bucket is bound here — the point is that it reached the
    // handler rather than the asset store.
    expect(res.status).toBe(503);
    expect(res.headers.get('x-asset-path')).toBeNull();
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  // A shared report is Worker-rendered HTML, not an SPA route: a link-preview
  // crawler does not run JavaScript, so the OG tags have to be in the bytes the
  // Worker returns. Falling through to the shell would hand every crawler the
  // same generic card.
  it('never serves the SPA shell for /r/<token>', async () => {
    const env = { ...makeEnv(['/index.html', '/404.html']), PROFILES: undefined };

    const res = await worker.fetch(
      get('https://www.timer.simple-tech.app/r/ABCDEFGHJKMNPQRS'),
      env,
      ctx
    );

    // 404 because no KV is bound here — the point is that it reached the
    // handler rather than the asset store.
    expect(res.status).toBe(404);
    expect(res.headers.get('x-asset-path')).toBeNull();
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
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

  it('marks web timer deep links noindex, but not bare /timer/app', async () => {
    const env = makeEnv(['/index.html']);
    const deep = await worker.fetch(
      get('https://www.timer.simple-tech.app/timer/app?role=Table%20Topics%20Speech&name=Test'),
      env,
      ctx
    );
    const bare = await worker.fetch(get('https://www.timer.simple-tech.app/timer/app'), env, ctx);

    expect(deep.status).toBe(200);
    expect(deep.headers.get('x-robots-tag')).toBe('noindex');
    expect(bare.headers.get('x-robots-tag')).toBeNull();
  });

  // A way back for existing users, not a page for search results.
  it('marks the reconnect page noindex', async () => {
    const env = makeEnv(['/index.html']);

    for (const path of ['/reconnect', '/reconnect/', '/reconnect?from=zoom']) {
      const res = await worker.fetch(get(`https://www.timer.simple-tech.app${path}`), env, ctx);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('x-asset-path'), path).toBe('/index.html');
      expect(res.headers.get('x-robots-tag'), path).toBe('noindex');
    }
  });

  it('does not mark look-alike paths noindex', async () => {
    const env = makeEnv(['/index.html', '/404.html']);
    const res = await worker.fetch(get('https://www.timer.simple-tech.app/reconnect-old'), env, ctx);

    expect(res.status).toBe(404);
    expect(res.headers.get('x-robots-tag')).toBeNull();
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
    expect(await res.json()).toEqual({ identified: false, isGuest: false, flags: FLAG_FALLBACKS });
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

describe('the Zoom contact endpoint', () => {
  const env = (assets = []) => ({ ...makeEnv(assets), SESSION_SIGNING_KEY: 'k', PROFILES: { get: async () => null, put: async () => {} } });

  it('is routed on every host, ahead of the SPA and the www redirect', async () => {
    for (const host of ['zoom.timer.simple-tech.app', 'timer.simple-tech.app', 'www.timer.simple-tech.app']) {
      const res = await worker.fetch(get(`https://${host}/api/zoom/contact`), env(['/zoom/index.html', '/index.html']), ctx);
      expect(res.status, host).toBe(405);
      expect(res.headers.get('content-type')).toContain('application/json');
    }
  });

  it('answers 401 to a POST without a session', async () => {
    const res = await worker.fetch(
      new Request('https://zoom.timer.simple-tech.app/api/zoom/contact', {
        method: 'POST',
        headers: { host: 'zoom.timer.simple-tech.app', 'content-type': 'application/json' },
        body: JSON.stringify({ code: 'c', codeVerifier: 'v'.repeat(64) }),
      }),
      env(['/zoom/index.html']),
      ctx
    );
    expect(res.status).toBe(401);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });
});

describe('/oauth/redirect: sign-in callback vs Marketplace install', () => {
  // Sign-in released, unless a case says otherwise.
  const authEnv = (FLAGS_FORCE = '1') => ({
    ...makeEnv(['/index.html']),
    SESSION_SIGNING_KEY: 'k',
    ZOOM_CLIENT_ID: 'cid',
    ZOOM_CLIENT_SECRET: 'sec',
    WEB_ORIGIN: 'https://www.timer.simple-tech.app',
    FLAGS_FORCE,
  });

  // The Marketplace "Add" flow lands here with a code and no state. It is sent
  // on to a clean URL that names the outcome, and the browser is marked as one
  // that has approved the app; never a session, whether or not web sign-in is
  // released.
  it('redirects an install callback without state to ?welcome=new and marks the browser', async () => {
    for (const FLAGS_FORCE of ['1', '0']) {
      const env = authEnv(FLAGS_FORCE);
      const res = await worker.fetch(get('https://www.timer.simple-tech.app/oauth/redirect?code=abc'), env, ctx);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('https://www.timer.simple-tech.app/oauth/redirect?welcome=new');
      expect(res.headers.get('cache-control')).toBe('no-store');
      const cookies = setCookies(res);
      expect(cookies).toHaveLength(1);
      expect(cookies[0]).toMatch(APPROVED_SET_COOKIE);
      expect(env.ASSETS.fetch).not.toHaveBeenCalled();
    }
  });

  it('redirects a browser that already carries the mark to ?welcome=back, and renews it', async () => {
    const res = await worker.fetch(get('https://www.timer.simple-tech.app/oauth/redirect?code=abc', { cookie: 'tt_approved=1' }), authEnv(), ctx);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://www.timer.simple-tech.app/oauth/redirect?welcome=back');
    expect(setCookies(res)[0]).toMatch(APPROVED_SET_COOKIE);
  });

  // Where the redirect lands: the install-success page, served as before.
  it('serves the SPA for the redirected landing, and sets nothing', async () => {
    for (const welcome of ['new', 'back']) {
      const res = await worker.fetch(get(`https://www.timer.simple-tech.app/oauth/redirect?welcome=${welcome}`, { cookie: 'tt_approved=1' }), authEnv(), ctx);
      expect(res.status).toBe(200);
      expect(res.headers.get('x-asset-path')).toBe('/index.html');
      expect(res.headers.get('set-cookie')).toBeNull();
      expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    }
  });

  // The zoom.<domain> host serves the Zoom shell for every path, this one too.
  it('leaves an install callback on the zoom host to the Zoom shell', async () => {
    const env = { ...authEnv(), ...makeEnv(['/zoom/index.html']) };
    const res = await worker.fetch(get('https://zoom.timer.simple-tech.app/oauth/redirect?code=abc', { cookie: 'tt_approved=1' }), env, createCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get('x-asset-path')).toBe('/zoom/index.html');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  // The install door spends Zoom's code in the background to save the user's
  // contact. The redirect must not wait for it: Zoom is held here until the
  // redirect has already been answered.
  it('saves the installing user\'s contact in the background, after answering the redirect', async () => {
    for (const FLAGS_FORCE of ['1', '0']) {
      const kv = makeKv();
      const env = { ...authEnv(FLAGS_FORCE), PROFILES: kv };
      const backgroundCtx = createCtx();

      let releaseZoom;
      const zoomHeld = new Promise((resolve) => { releaseZoom = resolve; });
      const realFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async (url) => {
        await zoomHeld;
        return String(url).includes('/oauth/token')
          ? new Response(JSON.stringify({ access_token: 'at' }), { status: 200 })
          : new Response(JSON.stringify({ id: 'zoom-installer', email: 'Installer@Example.com', first_name: 'Ina' }), { status: 200 });
      });
      try {
        const res = await worker.fetch(get('https://www.timer.simple-tech.app/oauth/redirect?code=abc'), env, backgroundCtx);
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe('https://www.timer.simple-tech.app/oauth/redirect?welcome=new');
        expect(setCookies(res)).toHaveLength(1);
        expect(setCookies(res)[0]).toMatch(APPROVED_SET_COOKIE);
        expect(kv.store.size).toBe(0);
        expect(backgroundCtx.pending()).toBe(1);

        releaseZoom();
        await backgroundCtx._settle();

        expect(JSON.parse(kv.store.get('contact:zoom:zoom-installer'))).toMatchObject({
          email: 'installer@example.com', firstName: 'Ina', lastName: null,
        });
        const [tokenUrl, init] = globalThis.fetch.mock.calls[0];
        expect(tokenUrl).toBe('https://zoom.us/oauth/token');
        expect(new URLSearchParams(init.body).get('redirect_uri')).toBe('https://www.timer.simple-tech.app/oauth/redirect');
        expect(new URLSearchParams(init.body).get('code')).toBe('abc');
      } finally {
        globalThis.fetch = realFetch;
      }
    }
  });

  // The old host's public pages 301 to ROOT_ORIGIN (#98), but the install landing
  // is an app route and stays: Zoom sends the user to WEB_ORIGIN/oauth/redirect,
  // and the code can only be spent with that same redirect_uri. If this page
  // moved, every Marketplace install would lose its page and its contact.
  it('keeps the install landing on the old www host once its public pages move', async () => {
    const kv = makeKv();
    const env = { ...authEnv(), ROOT_ORIGIN: 'https://www.toastmusters.com', PROFILES: kv };
    const backgroundCtx = createCtx();
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url) =>
      String(url).includes('/oauth/token')
        ? new Response(JSON.stringify({ access_token: 'at' }), { status: 200 })
        : new Response(JSON.stringify({ id: 'zoom-installer', email: 'installer@example.com' }), { status: 200 })
    );
    try {
      const res = await worker.fetch(get('https://www.timer.simple-tech.app/oauth/redirect?code=abc'), env, backgroundCtx);
      await backgroundCtx._settle();

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('https://www.timer.simple-tech.app/oauth/redirect?welcome=new');
      expect(setCookies(res)[0]).toMatch(APPROVED_SET_COOKIE);

      const [tokenUrl, init] = globalThis.fetch.mock.calls[0];
      expect(tokenUrl).toBe('https://zoom.us/oauth/token');
      expect(new URLSearchParams(init.body).get('redirect_uri')).toBe('https://www.timer.simple-tech.app/oauth/redirect');
      expect(JSON.parse(kv.store.get('contact:zoom:zoom-installer'))).toMatchObject({ email: 'installer@example.com' });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  // A failed capture (here: a reused code) is logged, never surfaced.
  it('redirects and marks the browser unchanged when the background capture fails', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const kv = makeKv();
    const backgroundCtx = createCtx();
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response('{"reason":"Invalid authorization code"}', { status: 400 }));
    try {
      const res = await worker.fetch(get('https://www.timer.simple-tech.app/oauth/redirect?code=used'), { ...authEnv(), PROFILES: kv }, backgroundCtx);
      await backgroundCtx._settle();

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('https://www.timer.simple-tech.app/oauth/redirect?welcome=new');
      expect(setCookies(res)[0]).toMatch(APPROVED_SET_COOKIE);
      expect(kv.store.size).toBe(0);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = realFetch;
      errors.mockRestore();
    }
  });

  it('spends no install code when no namespace is bound', async () => {
    const backgroundCtx = createCtx();
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response('{}'));
    try {
      const res = await worker.fetch(get('https://www.timer.simple-tech.app/oauth/redirect?code=abc'), authEnv(), backgroundCtx);
      await backgroundCtx._settle();

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('https://www.timer.simple-tech.app/oauth/redirect?welcome=new');
      expect(setCookies(res)[0]).toMatch(APPROVED_SET_COOKIE);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('serves the SPA for a state nobody signed, and does not treat it as an install', async () => {
    const backgroundCtx = createCtx();
    const res = await worker.fetch(get('https://www.timer.simple-tech.app/oauth/redirect?code=abc&state=forged.sig'), { ...authEnv(), PROFILES: makeKv() }, backgroundCtx);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-asset-path')).toBe('/index.html');
    expect(backgroundCtx.pending()).toBe(0);
  });

  // A sign-in spends its code once, in the callback, and saves the contact
  // there; the background install capture never runs for it.
  it('starts sign-in from /api/auth/zoom/start and completes it on the callback', async () => {
    const kv = makeKv();
    const env = { ...authEnv(), PROFILES: kv };
    const started = await worker.fetch(get('https://www.timer.simple-tech.app/api/auth/zoom/start?returnTo=%2Ftimer%2Fapp'), env, ctx);
    expect(started.status).toBe(302);
    const location = new URL(started.headers.get('location'));
    expect(location.hostname).toBe('zoom.us');
    const nonce = started.headers.get('set-cookie').match(/tt_oauth=([^;]+)/)[1];
    const state = location.searchParams.get('state');

    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url) =>
      String(url).includes('/oauth/token')
        ? new Response(JSON.stringify({ access_token: 'at' }), { status: 200 })
        : new Response(JSON.stringify({ id: 'zoom-user', email: 'user@example.com' }), { status: 200 })
    );
    try {
      const cb = new Request(`https://www.timer.simple-tech.app/oauth/redirect?code=c&state=${encodeURIComponent(state)}`, {
        headers: { host: 'www.timer.simple-tech.app', cookie: `tt_oauth=${nonce}` },
      });
      const backgroundCtx = createCtx();
      const res = await worker.fetch(cb, env, backgroundCtx);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('https://www.timer.simple-tech.app/timer/app');
      expect(res.headers.get('set-cookie')).toMatch(/tt_session=/);

      await backgroundCtx._settle();
      expect(JSON.parse(kv.store.get('contact:zoom:zoom-user'))).toMatchObject({ email: 'user@example.com' });
      expect(globalThis.fetch.mock.calls.filter(([url]) => String(url).includes('/oauth/token'))).toHaveLength(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  // pro off: the start is a URL that does not exist, and a callback
  // carrying a state we did sign lands on the install page like any other,
  // with no code exchange and no session.
  it('404s the start and serves the SPA for a signed callback while pro is off', async () => {
    const off = authEnv('0');
    const start = await worker.fetch(get('https://www.timer.simple-tech.app/api/auth/zoom/start?returnTo=%2Ftimer%2Fapp'), off, ctx);
    expect(start.status).toBe(404);
    expect(await start.json()).toEqual({ error: 'Not found' });
    expect(start.headers.get('set-cookie')).toBeNull();

    // A state minted while sign-in was on, spent after it went off.
    const started = await worker.fetch(get('https://www.timer.simple-tech.app/api/auth/zoom/start?returnTo=%2Ftimer%2Fapp'), authEnv('1'), ctx);
    const state = new URL(started.headers.get('location')).searchParams.get('state');
    const nonce = started.headers.get('set-cookie').match(/tt_oauth=([^;]+)/)[1];

    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response('{}'));
    try {
      const cb = new Request(`https://www.timer.simple-tech.app/oauth/redirect?code=c&state=${encodeURIComponent(state)}`, {
        headers: { host: 'www.timer.simple-tech.app', cookie: `tt_oauth=${nonce}` },
      });
      const res = await worker.fetch(cb, off, ctx);
      expect(res.status).toBe(200);
      expect(res.headers.get('x-asset-path')).toBe('/index.html');
      expect(res.headers.get('set-cookie')).toBeNull();
      expect(globalThis.fetch).not.toHaveBeenCalled();
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

// GitHub issue #96: Zoom drops a user whose approval lapsed on the root of the
// web host. A browser the install landing marked goes to the reconnect page
// instead of the marketing homepage. The rule itself is in reconnect.test.js;
// these prove where it sits among the Worker's other redirects.
describe('a marked browser opening a bare / goes to the reconnect page', () => {
  const MARK = 'tt_approved=1';

  it('302s www / to /reconnect, uncached, before any asset is looked up', async () => {
    const env = makeEnv(['/index.html']);
    const res = await worker.fetch(get('https://www.timer-dev.simple-tech.app/', { cookie: MARK }), env, ctx);

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://www.timer-dev.simple-tech.app/reconnect');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  // The mark the install landing writes is the one the homepage reads.
  it('recognises the browser the install landing just marked', async () => {
    const landing = await worker.fetch(get('https://www.timer.simple-tech.app/oauth/redirect?code=abc'), makeEnv(['/index.html']), createCtx());
    const cookie = setCookies(landing)[0].split(';')[0];

    const res = await worker.fetch(get('https://www.timer.simple-tech.app/', { cookie }), makeEnv(['/index.html']), ctx);

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://www.timer.simple-tech.app/reconnect');
  });

  // The apex canonicalizes first, in one hop; www then asks about the mark.
  it('301s a marked apex / to www first', async () => {
    const env = makeEnv(['/index.html']);
    const res = await worker.fetch(get('https://timer-dev.simple-tech.app/', { cookie: MARK }), env, ctx);

    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('https://www.timer-dev.simple-tech.app/');
  });

  it('moves the old timer.toastmusters.com host first, too', async () => {
    const env = { ...makeEnv(['/index.html']), ROOT_ORIGIN: 'https://www.toastmusters.com' };
    const res = await worker.fetch(get('https://www.timer.toastmusters.com/', { cookie: MARK }), env, ctx);

    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('https://www.toastmusters.com/');
  });

  // The zoom.<domain> host is the Zoom app: its / is the sidebar shell, mark
  // or no mark.
  it('leaves the zoom host serving the Zoom shell', async () => {
    const env = makeEnv(['/zoom/index.html']);
    const res = await worker.fetch(get('https://zoom.timer-dev.simple-tech.app/', { cookie: MARK }), env, ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get('x-asset-path')).toBe('/zoom/index.html');
    expect(res.headers.get('location')).toBeNull();
  });

  it('serves an unmarked browser the homepage, unchanged', async () => {
    for (const cookie of [undefined, 'tt_session=x.y']) {
      const res = await worker.fetch(get('https://www.timer.simple-tech.app/', { cookie }), makeEnv(['/index.html']), ctx);

      expect(res.status, String(cookie)).toBe(200);
      expect(res.headers.get('x-asset-path')).toBe('/index.html');
      expect(res.headers.get('location')).toBeNull();
      expect(res.headers.get('x-robots-tag')).toBeNull();
    }
  });

  // "Go to the homepage" on the reconnect page is /?home, and marketing links
  // carry ?utm_…: a query string always reaches the homepage.
  it.each(['/?home', '/?utm_source=newsletter'])('serves a marked browser the homepage at %s', async (path) => {
    const res = await worker.fetch(get(`https://www.timer.simple-tech.app${path}`, { cookie: MARK }), makeEnv(['/index.html']), ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get('x-asset-path')).toBe('/index.html');
    expect(res.headers.get('location')).toBeNull();
  });

  // Once the old web host's public pages move (#98), its / is the one that 301s
  // to the main site. A marked browser must still reach the reconnect page here:
  // the mark is host-only, so the main site could never send it there.
  describe('on the old web host, once its public pages move', () => {
    const env = () => ({ ...makeEnv(['/index.html']), ROOT_ORIGIN: 'https://www.toastmusters.com' });

    it('302s a marked / to /reconnect on the old host, not to the main site', async () => {
      const res = await worker.fetch(get('https://www.timer.simple-tech.app/', { cookie: MARK }), env(), ctx);

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('https://www.timer.simple-tech.app/reconnect');
    });

    it('301s an unmarked / to the main site, uncached', async () => {
      const res = await worker.fetch(get('https://www.timer.simple-tech.app/'), env(), ctx);

      expect(res.status).toBe(301);
      expect(res.headers.get('location')).toBe('https://www.toastmusters.com/');
      expect(res.headers.get('cache-control')).toBe('no-store');
    });

    it('301s a marked /?home to the main site homepage', async () => {
      const res = await worker.fetch(get('https://www.timer.simple-tech.app/?home', { cookie: MARK }), env(), ctx);

      expect(res.status).toBe(301);
      expect(res.headers.get('location')).toBe('https://www.toastmusters.com/?home');
    });

    it('serves the reconnect page itself on the old host', async () => {
      const res = await worker.fetch(get('https://www.timer.simple-tech.app/reconnect', { cookie: MARK }), env(), ctx);

      expect(res.status).toBe(200);
      expect(res.headers.get('x-asset-path')).toBe('/index.html');
    });
  });

  it('serves the reconnect page itself to a marked browser, with no loop', async () => {
    const res = await worker.fetch(get('https://www.timer.simple-tech.app/reconnect', { cookie: MARK }), makeEnv(['/index.html']), ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get('x-asset-path')).toBe('/index.html');
  });
});

describe('zoom launch marker', () => {
  // The real shell, near enough: the marker is injected right after <head>.
  // `/zoom/` answers as well as `/zoom/index.html` because that is what the
  // asset store's html_handling does — and answering it there is what used to
  // let the shell out unmarked.
  function htmlEnv() {
    return {
      ASSETS: {
        fetch: vi.fn((request) => {
          const { pathname } = new URL(request.url);
          if (pathname === '/zoom/support.html') {
            return Promise.resolve(
              new Response('<html><head></head><body>support</body></html>', {
                status: 200,
                headers: { 'content-type': 'text/html', 'x-asset-path': pathname },
              })
            );
          }
          if (pathname !== '/zoom/index.html' && pathname !== '/zoom/') {
            return Promise.resolve(new Response('not found', { status: 404 }));
          }
          return Promise.resolve(
            new Response('<!doctype html>\n<html>\n  <head>\n    <title>t</title>\n  </head>\n  <body></body>\n</html>', {
              status: 200,
              headers: {
                'content-type': 'text/html',
                'x-asset-path': pathname,
                'content-length': '84',
                etag: '"stored-shell"',
              },
            })
          );
        }),
      },
    };
  }

  function zoomRequest(headers = {}) {
    return new Request('https://zoom.timer.simple-tech.app/', {
      headers: { host: 'zoom.timer.simple-tech.app', ...headers },
    });
  }

  it('marks the shell as a Zoom client launch when the app context header is present', async () => {
    const res = await worker.fetch(zoomRequest({ 'x-zoom-app-context': 'opaque-blob' }), htmlEnv(), ctx);

    expect(await res.text()).toContain('<meta name="zoom-launch" content="client">');
  });

  it('marks the shell as a browser launch when the header is absent', async () => {
    const res = await worker.fetch(zoomRequest(), htmlEnv(), ctx);

    expect(await res.text()).toContain('<meta name="zoom-launch" content="browser">');
  });

  it('marks the /zoom path shell too, not just the subdomain', async () => {
    const res = await worker.fetch(
      new Request('https://www.timer.simple-tech.app/zoom/anything', {
        headers: { host: 'www.timer.simple-tech.app', 'x-zoom-app-context': 'opaque-blob' },
      }),
      htmlEnv(),
      ctx
    );

    expect(await res.text()).toContain('<meta name="zoom-launch" content="client">');
  });

  // Regression: the asset store answers "/zoom/" itself, so the marker has to
  // be applied before that lookup, not only in the SPA fallback behind it.
  it('marks the shell even when the asset store can serve the path directly', async () => {
    const res = await worker.fetch(
      new Request('https://www.timer.simple-tech.app/zoom/', {
        headers: { host: 'www.timer.simple-tech.app', 'x-zoom-app-context': 'opaque-blob' },
      }),
      htmlEnv(),
      ctx
    );

    expect(await res.text()).toContain('<meta name="zoom-launch" content="client">');
  });

  // Only the app shell is per-request. The static Zoom pages stay cacheable.
  it('leaves the other Zoom pages unmarked and cacheable', async () => {
    const res = await worker.fetch(
      new Request('https://www.timer.simple-tech.app/zoom/support.html', {
        headers: { host: 'www.timer.simple-tech.app', 'x-zoom-app-context': 'opaque-blob' },
      }),
      { ...htmlEnv(), ZOOM_CLIENT_ID: 'dev-client', WEB_ORIGIN: 'https://www.timer-dev.simple-tech.app' },
      ctx
    );

    const html = await res.text();
    expect(html).not.toContain('zoom-launch');
    expect(html).not.toContain('zoom-install-url');
    expect(res.headers.get('cache-control')).not.toBe('no-store');
  });

  // The "add the app" link has to name the app this Worker belongs to: the dev
  // Worker used to serve a bundle whose build-time link installed production.
  it('stamps the install link for this deployment’s Zoom app', async () => {
    const res = await worker.fetch(zoomRequest({ 'x-zoom-app-context': 'opaque-blob' }), { ...htmlEnv(), ZOOM_CLIENT_ID: 'dev-client', WEB_ORIGIN: 'https://www.timer-dev.simple-tech.app' }, ctx);

    expect(await res.text()).toContain(
      '<meta name="zoom-install-url" content="https://zoom.us/oauth/authorize?response_type=code&amp;client_id=dev-client&amp;redirect_uri=https%3A%2F%2Fwww.timer-dev.simple-tech.app%2Foauth%2Fredirect">'
    );
  });

  // No link is better than a wrong one: the app falls back to its build-time
  // value, which is what it always used.
  it('leaves the install link out when the Worker has no OAuth configuration', async () => {
    const res = await worker.fetch(zoomRequest(), htmlEnv(), ctx);

    const html = await res.text();
    expect(html).toContain('zoom-launch');
    expect(html).not.toContain('zoom-install-url');
  });

  it('leaves the rest of the document alone', async () => {
    const res = await worker.fetch(zoomRequest(), htmlEnv(), ctx);
    const html = await res.text();

    expect(html).toContain('<title>t</title>');
    expect(html.startsWith('<!doctype html>')).toBe(true);
  });

  it('refuses to cache the shell, since the marker differs per request', async () => {
    const res = await worker.fetch(zoomRequest(), htmlEnv(), ctx);

    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  // Both headers describe the stored asset, and injecting the marker makes them
  // wrong — a stale content-length is enough to truncate the shell.
  it('drops the stored asset’s length and etag', async () => {
    const res = await worker.fetch(zoomRequest(), htmlEnv(), ctx);

    expect(res.headers.get('content-length')).toBeNull();
    expect(res.headers.get('etag')).toBeNull();
  });

  it('still applies the Zoom CSP to the marked shell', async () => {
    const res = await worker.fetch(zoomRequest(), htmlEnv(), ctx);

    expect(res.headers.get('content-security-policy')).toContain('appssdk.zoom.us');
  });
});
