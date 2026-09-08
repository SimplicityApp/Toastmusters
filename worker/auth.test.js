import { describe, it, expect, vi } from 'vitest';
import {
  readSession,
  parseCookies,
  verifyState,
  sanitizeReturnTo,
  handleAuthStart,
  handleOAuthCallback,
  handleLogout,
  SESSION_COOKIE,
  WEB_SESSION_TTL_MS,
} from './auth.js';
import { mintSessionToken, verifySessionToken } from './session-token.js';

const SIGNING_KEY = 'test-session-signing-key';
const NOW = 1_800_000_000_000;
const env = {
  SESSION_SIGNING_KEY: SIGNING_KEY,
  ZOOM_CLIENT_ID: 'client-id',
  ZOOM_CLIENT_SECRET: 'client-secret',
  WEB_ORIGIN: 'https://www.example.test',
};

const setCookies = (res) => res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie')].filter(Boolean);
const cookieValue = (res, name) => {
  const line = setCookies(res).find((c) => c.startsWith(`${name}=`));
  return line ? line.slice(name.length + 1).split(';')[0] : null;
};

describe('parseCookies / sanitizeReturnTo', () => {
  it('parses a cookie header and ignores junk', () => {
    expect(parseCookies('a=1; tt_session=abc.def; empty; =x')).toEqual({ a: '1', tt_session: 'abc.def' });
    expect(parseCookies(null)).toEqual({});
  });

  it('only allows same-site paths as return targets', () => {
    expect(sanitizeReturnTo('/account?x=1')).toBe('/account?x=1');
    expect(sanitizeReturnTo('https://evil.test')).toBe('/app');
    expect(sanitizeReturnTo('//evil.test/x')).toBe('/app');
    expect(sanitizeReturnTo('/a\\b')).toBe('/app');
    expect(sanitizeReturnTo(undefined)).toBe('/app');
  });
});

describe('readSession', () => {
  const token = mintSessionToken('u1', SIGNING_KEY);

  it('reads a bearer token with no CSRF checks', () => {
    const req = new Request('https://x/api/profile', {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, origin: 'https://evil.test', 'sec-fetch-site': 'cross-site' },
    });
    expect(readSession(req, env)).toMatchObject({ uid: 'u1', via: 'bearer' });
  });

  it('reads the session cookie for same-origin requests', () => {
    const req = new Request('https://www.example.test/api/profile', {
      method: 'PUT',
      headers: { cookie: `x=1; ${SESSION_COOKIE}=${token}`, host: 'www.example.test', origin: 'https://www.example.test', 'sec-fetch-site': 'same-origin' },
    });
    expect(readSession(req, env)).toMatchObject({ uid: 'u1', via: 'cookie' });
  });

  it('refuses the cookie on cross-site fetches and foreign-origin mutations', () => {
    const base = { cookie: `${SESSION_COOKIE}=${token}`, host: 'www.example.test' };
    const crossSite = new Request('https://www.example.test/api/me', { headers: { ...base, 'sec-fetch-site': 'cross-site' } });
    expect(readSession(crossSite, env)).toBeNull();

    const foreignOrigin = new Request('https://www.example.test/api/profile', {
      method: 'PUT',
      headers: { ...base, origin: 'https://evil.test' },
    });
    expect(readSession(foreignOrigin, env)).toBeNull();

    // A GET with no fetch metadata (an old browser, a typed URL) is fine.
    const plainGet = new Request('https://www.example.test/api/me', { headers: base });
    expect(readSession(plainGet, env)).toMatchObject({ uid: 'u1' });
  });

  it('refuses a forged or missing cookie', () => {
    const forged = mintSessionToken('u1', 'other-key');
    expect(readSession(new Request('https://x/', { headers: { cookie: `${SESSION_COOKIE}=${forged}` } }), env)).toBeNull();
    expect(readSession(new Request('https://x/'), env)).toBeNull();
  });
});

describe('handleAuthStart', () => {
  const start = (query = '?returnTo=%2Faccount') =>
    handleAuthStart(new Request(`https://www.example.test/api/auth/zoom/start${query}`), new URL(`https://www.example.test/api/auth/zoom/start${query}`), env, { now: NOW });

  it('redirects to Zoom with a signed state and sets the nonce cookie', () => {
    const res = start();
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location'));
    expect(location.origin + location.pathname).toBe('https://zoom.us/oauth/authorize');
    expect(location.searchParams.get('client_id')).toBe('client-id');
    expect(location.searchParams.get('redirect_uri')).toBe('https://www.example.test/oauth/redirect');

    const state = verifyState(location.searchParams.get('state'), SIGNING_KEY, NOW);
    expect(state).toMatchObject({ purpose: 'signin', returnTo: '/account' });
    expect(cookieValue(res, 'tt_oauth')).toBe(state.nonce);
    expect(setCookies(res)[0]).toMatch(/HttpOnly; Secure; SameSite=Lax/);
  });

  it('answers 503 when the client id or origin is missing', () => {
    const url = new URL('https://x/api/auth/zoom/start');
    expect(handleAuthStart(new Request(url), url, { ...env, ZOOM_CLIENT_ID: undefined }).status).toBe(503);
    expect(handleAuthStart(new Request(url), url, { ...env, WEB_ORIGIN: undefined }).status).toBe(503);
  });
});

describe('handleOAuthCallback', () => {
  function zoomFetch({ tokenOk = true, meOk = true, id = 'zoom-user-1' } = {}) {
    return vi.fn(async (url) => {
      if (String(url).startsWith('https://zoom.us/oauth/token')) {
        return new Response(JSON.stringify(tokenOk ? { access_token: 'at', refresh_token: 'rt' } : { error: 'x' }), { status: tokenOk ? 200 : 400 });
      }
      if (String(url).startsWith('https://api.zoom.us/v2/users/me')) {
        return new Response(JSON.stringify(meOk ? { id, email: 'a@b.c' } : {}), { status: meOk ? 200 : 401 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
  }

  function startAndCallback({ code = 'the-code', withNonce = true, tamperState = false, fetchImpl = zoomFetch(), stateOverride } = {}) {
    const startUrl = new URL('https://www.example.test/api/auth/zoom/start?returnTo=%2Faccount');
    const started = handleAuthStart(new Request(startUrl), startUrl, env, { now: NOW });
    const location = new URL(started.headers.get('location'));
    let state = stateOverride ?? location.searchParams.get('state');
    if (tamperState) state = state.slice(0, -2) + 'zz';
    const nonce = cookieValue(started, 'tt_oauth');

    const cb = new URL('https://www.example.test/oauth/redirect');
    cb.searchParams.set('state', state);
    if (code) cb.searchParams.set('code', code);
    const req = new Request(cb, { headers: withNonce ? { cookie: `tt_oauth=${nonce}` } : {} });
    return { promise: handleOAuthCallback(req, cb, env, { fetchImpl, now: NOW + 1000 }), fetchImpl };
  }

  it('exchanges the code, reads the Zoom user id and sets a 30-day session cookie', async () => {
    const { promise, fetchImpl } = startAndCallback();
    const res = await promise;

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://www.example.test/account');
    const token = cookieValue(res, SESSION_COOKIE);
    const session = verifySessionToken(token, SIGNING_KEY, NOW + 1000);
    expect(session.uid).toBe('zoom-user-1');
    expect(session.exp).toBe(NOW + 1000 + WEB_SESSION_TTL_MS);
    expect(cookieValue(res, 'tt_oauth')).toBe('');

    const [tokenUrl, init] = fetchImpl.mock.calls[0];
    expect(tokenUrl).toBe('https://zoom.us/oauth/token');
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from('client-id:client-secret').toString('base64')}`);
    expect(init.body).toBe('grant_type=authorization_code&code=the-code&redirect_uri=https%3A%2F%2Fwww.example.test%2Foauth%2Fredirect');
    expect(fetchImpl.mock.calls[1][1].headers.Authorization).toBe('Bearer at');
  });

  // The Marketplace install flow shares this URL and sends no state. It must
  // keep reaching the SPA, and must never produce a session.
  it('falls through (null) when there is no state or the state is not ours', async () => {
    const url = new URL('https://www.example.test/oauth/redirect?code=abc');
    expect(await handleOAuthCallback(new Request(url), url, env)).toBeNull();

    const { promise } = startAndCallback({ tamperState: true });
    expect(await promise).toBeNull();
  });

  it('fails closed without the nonce cookie (login CSRF)', async () => {
    const { promise, fetchImpl } = startAndCallback({ withNonce: false });
    const res = await promise;
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://www.example.test/account?signin=failed&reason=state_mismatch');
    expect(cookieValue(res, SESSION_COOKIE)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports a declined consent and Zoom-side failures without a session', async () => {
    expect((await startAndCallback({ code: null }).promise).headers.get('location')).toContain('reason=no_code');
    expect((await startAndCallback({ fetchImpl: zoomFetch({ tokenOk: false }) }).promise).headers.get('location')).toContain('reason=exchange');
    const noProfile = await startAndCallback({ fetchImpl: zoomFetch({ meOk: false }) }).promise;
    expect(noProfile.headers.get('location')).toContain('reason=profile');
    expect(cookieValue(noProfile, SESSION_COOKIE)).toBeNull();
  });

  it('rejects an expired state', async () => {
    const startUrl = new URL('https://www.example.test/api/auth/zoom/start');
    const started = handleAuthStart(new Request(startUrl), startUrl, env, { now: NOW - 11 * 60 * 1000 });
    const state = new URL(started.headers.get('location')).searchParams.get('state');
    const cb = new URL(`https://www.example.test/oauth/redirect?code=x&state=${encodeURIComponent(state)}`);
    expect(await handleOAuthCallback(new Request(cb, { headers: { cookie: `tt_oauth=${cookieValue(started, 'tt_oauth')}` } }), cb, env, { now: NOW })).toBeNull();
  });
});

describe('handleLogout', () => {
  it('clears the cookie on POST only', () => {
    const res = handleLogout(new Request('https://x/api/auth/logout', { method: 'POST' }));
    expect(res.status).toBe(200);
    expect(setCookies(res)[0]).toMatch(new RegExp(`^${SESSION_COOKIE}=; Path=/; Max-Age=0`));
    expect(handleLogout(new Request('https://x/api/auth/logout')).status).toBe(405);
  });
});
