import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  readSession,
  parseCookies,
  verifyState,
  sanitizeReturnTo,
  withoutSigninParams,
  handleAuthStart,
  handleOAuthCallback,
  handleLogout,
  tokenLacksUserRead,
  classifyProfileFailure,
  SESSION_COOKIE,
  WEB_SESSION_TTL_MS,
} from './auth.js';
import { mintSessionToken, verifySessionToken } from './session-token.js';
import { POSTHOG_CAPTURE_URL } from './posthog.js';

const SIGNING_KEY = 'test-session-signing-key';
const NOW = 1_800_000_000_000;
// Sign-in released: these cases are about how it behaves once it is on. Its
// dark position is covered in flags.test.js with the other gated endpoints.
const env = {
  SESSION_SIGNING_KEY: SIGNING_KEY,
  ZOOM_CLIENT_ID: 'client-id',
  ZOOM_CLIENT_SECRET: 'client-secret',
  WEB_ORIGIN: 'https://www.example.test',
  FLAGS_FORCE: '1',
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
    expect(sanitizeReturnTo('https://evil.test')).toBe('/timer/app');
    expect(sanitizeReturnTo('//evil.test/x')).toBe('/timer/app');
    expect(sanitizeReturnTo('/a\\b')).toBe('/timer/app');
    expect(sanitizeReturnTo(undefined)).toBe('/timer/app');
  });
});

describe('withoutSigninParams', () => {
  it('drops an earlier failure from the return path, keeping everything else', () => {
    expect(withoutSigninParams('/account?signin=failed&reason=x&tab=1')).toBe('/account?tab=1');
    expect(withoutSigninParams('/account?signin=failed&reason=denied')).toBe('/account');
    expect(withoutSigninParams('/club/admin?tab=1&signin=failed&reason=profile#members')).toBe('/club/admin?tab=1#members');
  });

  it('leaves a path without failure params exactly as it was', () => {
    expect(withoutSigninParams('/account')).toBe('/account');
    expect(withoutSigninParams('/timer/app?q=a%20b')).toBe('/timer/app?q=a%20b');
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

  it('redirects to Zoom with a signed state and sets the nonce cookie', async () => {
    const res = await start();
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

  it('answers 503 when the client id or origin is missing', async () => {
    const url = new URL('https://x/api/auth/zoom/start');
    expect((await handleAuthStart(new Request(url), url, { ...env, ZOOM_CLIENT_ID: undefined })).status).toBe(503);
    expect((await handleAuthStart(new Request(url), url, { ...env, WEB_ORIGIN: undefined })).status).toBe(503);
  });

  // The nonce cookie is host-only and the callback always lands on WEB_ORIGIN,
  // so starting anywhere else used to come back as a state mismatch.
  it('hands a start on a non-canonical host to WEB_ORIGIN, without a cookie', async () => {
    for (const host of ['timer.example.test', 'www.other.test']) {
      const url = new URL(`https://${host}/api/auth/zoom/start?returnTo=%2Fclub%2Fadmin`);
      const res = await handleAuthStart(new Request(url), url, env, { now: NOW });

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(
        'https://www.example.test/api/auth/zoom/start?returnTo=%2Fclub%2Fadmin'
      );
      expect(setCookies(res)).toEqual([]);
    }
  });

  it('carries a rejected returnTo to the canonical host as the safe default', async () => {
    const url = new URL('https://timer.example.test/api/auth/zoom/start?returnTo=https%3A%2F%2Fevil.test');
    const res = await handleAuthStart(new Request(url), url, env, { now: NOW });
    expect(res.headers.get('location')).toBe('https://www.example.test/api/auth/zoom/start?returnTo=%2Ftimer%2Fapp');
  });

  // `wrangler dev` rewrites the Host header to the first configured route, so a
  // host check that ignored this would bounce every local request at production.
  it('leaves http starts alone so local development still works', async () => {
    const url = new URL('http://localhost:8787/api/auth/zoom/start?returnTo=%2Fapp');
    const res = await handleAuthStart(new Request(url), url, env, { now: NOW });
    expect(new URL(res.headers.get('location')).origin).toBe('https://zoom.us');
    expect(cookieValue(res, 'tt_oauth')).toBeTruthy();
  });
});

// What Zoom answers GET /v2/users/me with, per research §7.
const MISSING_SCOPE_BODY = {
  code: 4711,
  message: 'Invalid access token, does not contain scopes:[user:read:user:admin, user:read:user].',
};
const BAD_TOKEN_BODY = { code: 124, message: 'Invalid access token.' };

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status });

describe('tokenLacksUserRead', () => {
  it('is false when Zoom sent no scope string: unknown is not missing', () => {
    expect(tokenLacksUserRead(undefined)).toBe(false);
    expect(tokenLacksUserRead(null)).toBe(false);
    expect(tokenLacksUserRead(42)).toBe(false);
    expect(tokenLacksUserRead(['zoomapp:inmeeting'])).toBe(false);
  });

  it('is false when any user-read scope is granted', () => {
    expect(tokenLacksUserRead('user:read:user')).toBe(false);
    expect(tokenLacksUserRead('user:read:user:admin')).toBe(false);
    expect(tokenLacksUserRead('user:read')).toBe(false);
    expect(tokenLacksUserRead('user:read:admin')).toBe(false);
    expect(tokenLacksUserRead('zoomapp:inmeeting user:read:user')).toBe(false);
    expect(tokenLacksUserRead('  zoomapp:inmeeting   user:read:user  ')).toBe(false);
  });

  it('is true when the scope string names none of them', () => {
    expect(tokenLacksUserRead('zoomapp:inmeeting')).toBe(true);
    expect(tokenLacksUserRead('zoomapp:inmeeting user:read:token')).toBe(true);
    expect(tokenLacksUserRead('user:read:user:extra')).toBe(true);
    expect(tokenLacksUserRead('')).toBe(true);
  });
});

describe('classifyProfileFailure', () => {
  let logged;
  beforeEach(() => {
    logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    logged.mockRestore();
  });

  it('labels Zoom\'s 400 / 4711 "does not contain scopes" a missing scope', async () => {
    const result = await classifyProfileFailure(jsonResponse(MISSING_SCOPE_BODY, 400), undefined);
    expect(result).toEqual({
      reason: 'scope_not_granted',
      details: { zoom_status: 400, zoom_code: 4711, scope_signal: 'error_code' },
    });
  });

  it('labels a bad or expired token (401 / 124) a profile failure, not a scope one', async () => {
    const result = await classifyProfileFailure(jsonResponse(BAD_TOKEN_BODY, 401), 'user:read:user');
    expect(result).toEqual({ reason: 'profile', details: { zoom_status: 401, zoom_code: 124 } });
  });

  it('recognises the rare code 104 by its message', async () => {
    const body = { code: 104, message: 'Invalid access token, does not contain scopes:[user:read:user].' };
    const result = await classifyProfileFailure(jsonResponse(body, 400), 'user:read:user');
    expect(result).toMatchObject({ reason: 'scope_not_granted', details: { zoom_code: 104, scope_signal: 'error_code' } });
  });

  it('trusts a granted scope that names no user-read scope, whatever the error', async () => {
    const result = await classifyProfileFailure(jsonResponse(BAD_TOKEN_BODY, 401), 'zoomapp:inmeeting');
    expect(result).toEqual({
      reason: 'scope_not_granted',
      details: { zoom_status: 401, zoom_code: 124, scope_signal: 'token_scope' },
    });
  });

  it('says "both" when the scope and the error agree', async () => {
    const result = await classifyProfileFailure(jsonResponse(MISSING_SCOPE_BODY, 400), 'zoomapp:inmeeting');
    expect(result.details.scope_signal).toBe('both');
  });

  it('never throws on an unreadable body: it counts as "no code"', async () => {
    const result = await classifyProfileFailure(new Response('<html>oops</html>', { status: 502 }), undefined);
    expect(result).toEqual({ reason: 'profile', details: { zoom_status: 502, zoom_code: null } });
  });

  it('logs the status, the code and the signal, never the token', async () => {
    await classifyProfileFailure(jsonResponse(MISSING_SCOPE_BODY, 400), 'zoomapp:inmeeting');
    expect(logged).toHaveBeenCalledWith('Zoom users/me failed:', 400, 4711, 'token-scope,error-code');

    await classifyProfileFailure(jsonResponse({}, 500), undefined);
    expect(logged).toHaveBeenLastCalledWith('Zoom users/me failed:', 500, '-', 'no-scope-signal');
  });
});

describe('handleOAuthCallback', () => {
  /**
   * Routes by URL: Zoom's token endpoint, /users/me, and PostHog's capture
   * (which only sees calls when POSTHOG_API_KEY is set).
   */
  function zoomFetch({ tokenOk = true, meOk = true, id = 'zoom-user-1', scope, meStatus = 401, meBody = {}, posthog } = {}) {
    return vi.fn(async (url) => {
      if (String(url).startsWith(POSTHOG_CAPTURE_URL)) {
        return posthog ? posthog() : new Response('{"status":1}');
      }
      if (String(url).startsWith('https://zoom.us/oauth/token')) {
        const tokens = { access_token: 'at', refresh_token: 'rt', ...(scope !== undefined && { scope }) };
        return new Response(JSON.stringify(tokenOk ? tokens : { error: 'x' }), { status: tokenOk ? 200 : 400 });
      }
      if (String(url).startsWith('https://api.zoom.us/v2/users/me')) {
        return meOk ? jsonResponse({ id, email: 'a@b.c' }) : jsonResponse(meBody, meStatus);
      }
      throw new Error(`unexpected fetch ${url}`);
    });
  }

  /** The PostHog events this fetch mock carried, as parsed bodies. */
  const captures = (fetchImpl) =>
    fetchImpl.mock.calls
      .filter(([url]) => String(url).startsWith(POSTHOG_CAPTURE_URL))
      .map(([, init]) => JSON.parse(init.body));

  async function startAndCallback({
    code = 'the-code',
    withNonce = true,
    tamperState = false,
    fetchImpl = zoomFetch(),
    stateOverride,
    callbackEnv = env,
    ctx,
    returnTo = '/account',
  } = {}) {
    const startUrl = new URL('https://www.example.test/api/auth/zoom/start');
    startUrl.searchParams.set('returnTo', returnTo);
    const started = await handleAuthStart(new Request(startUrl), startUrl, env, { now: NOW });
    const location = new URL(started.headers.get('location'));
    let state = stateOverride ?? location.searchParams.get('state');
    if (tamperState) state = state.slice(0, -2) + 'zz';
    const nonce = cookieValue(started, 'tt_oauth');

    const cb = new URL('https://www.example.test/oauth/redirect');
    cb.searchParams.set('state', state);
    if (code) cb.searchParams.set('code', code);
    const req = new Request(cb, { headers: withNonce ? { cookie: `tt_oauth=${nonce}` } : {} });
    return { promise: handleOAuthCallback(req, cb, callbackEnv, { fetchImpl, now: NOW + 1000, ctx }), fetchImpl, nonce };
  }

  it('exchanges the code, reads the Zoom user id and sets a 30-day session cookie', async () => {
    const { promise, fetchImpl } = await startAndCallback();
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

    const { promise } = await startAndCallback({ tamperState: true });
    expect(await promise).toBeNull();
  });

  it('fails closed without the nonce cookie (login CSRF)', async () => {
    const { promise, fetchImpl } = await startAndCallback({ withNonce: false });
    const res = await promise;
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://www.example.test/account?signin=failed&reason=state_mismatch');
    expect(cookieValue(res, SESSION_COOKIE)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports a declined consent and Zoom-side failures without a session', async () => {
    expect((await (await startAndCallback({ code: null })).promise).headers.get('location')).toContain('reason=no_code');
    expect((await (await startAndCallback({ fetchImpl: zoomFetch({ tokenOk: false }) })).promise).headers.get('location')).toContain('reason=exchange');
    const noProfile = await (await startAndCallback({ fetchImpl: zoomFetch({ meOk: false }) })).promise;
    expect(noProfile.headers.get('location')).toContain('reason=profile');
    expect(cookieValue(noProfile, SESSION_COOKIE)).toBeNull();
  });

  // A retry from a failed URL carries the failure params in its returnTo; a
  // sign-in that works must not land back on them.
  it('strips an earlier failure from returnTo on success', async () => {
    const res = await (await startAndCallback({ returnTo: '/account?signin=failed&reason=x&tab=1' })).promise;
    expect(res.headers.get('location')).toBe('https://www.example.test/account?tab=1');
    expect(cookieValue(res, SESSION_COOKIE)).not.toBeNull();
  });

  it('replaces, not appends to, an earlier failure when the retry fails too', async () => {
    const fetchImpl = zoomFetch({ tokenOk: false });
    const res = await (await startAndCallback({ fetchImpl, returnTo: '/account?signin=failed&reason=denied&tab=1' })).promise;
    expect(res.headers.get('location')).toBe('https://www.example.test/account?signin=failed&reason=exchange&tab=1');
  });

  it('rejects an expired state', async () => {
    const startUrl = new URL('https://www.example.test/api/auth/zoom/start');
    const started = await handleAuthStart(new Request(startUrl), startUrl, env, { now: NOW - 11 * 60 * 1000 });
    const state = new URL(started.headers.get('location')).searchParams.get('state');
    const cb = new URL(`https://www.example.test/oauth/redirect?code=x&state=${encodeURIComponent(state)}`);
    expect(await handleOAuthCallback(new Request(cb, { headers: { cookie: `tt_oauth=${cookieValue(started, 'tt_oauth')}` } }), cb, env, { now: NOW })).toBeNull();
  });

  describe('a missing permission is told apart from a bad token', () => {
    let logged;
    beforeEach(() => {
      logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => {
      logged.mockRestore();
    });

    it('sends 400 / 4711 back as reason=scope_not_granted, without a session', async () => {
      const fetchImpl = zoomFetch({ meOk: false, meStatus: 400, meBody: MISSING_SCOPE_BODY });
      const res = await (await startAndCallback({ fetchImpl })).promise;
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('https://www.example.test/account?signin=failed&reason=scope_not_granted');
      expect(cookieValue(res, SESSION_COOKIE)).toBeNull();
      expect(cookieValue(res, 'tt_oauth')).toBe('');
      expect(logged).toHaveBeenCalledWith('Zoom users/me failed:', 400, 4711, 'error-code');
    });

    it('keeps 401 / 124 (a bad or expired token) as reason=profile', async () => {
      const fetchImpl = zoomFetch({ meOk: false, meStatus: 401, meBody: BAD_TOKEN_BODY, scope: 'user:read:user' });
      const res = await (await startAndCallback({ fetchImpl })).promise;
      expect(res.headers.get('location')).toBe('https://www.example.test/account?signin=failed&reason=profile');
    });

    it('labels a failure scope_not_granted when the granted scope lacks user-read', async () => {
      const fetchImpl = zoomFetch({ meOk: false, meStatus: 401, meBody: BAD_TOKEN_BODY, scope: 'zoomapp:inmeeting' });
      const res = await (await startAndCallback({ fetchImpl })).promise;
      expect(res.headers.get('location')).toContain('reason=scope_not_granted');
    });

    // The scope can lag a Marketplace change: a profile read that works wins.
    it('still signs in when the granted scope looks narrow but /users/me answers', async () => {
      const fetchImpl = zoomFetch({ scope: 'zoomapp:inmeeting' });
      const res = await (await startAndCallback({ fetchImpl })).promise;
      expect(res.headers.get('location')).toBe('https://www.example.test/account');
      expect(verifySessionToken(cookieValue(res, SESSION_COOKIE), SIGNING_KEY, NOW + 1000).uid).toBe('zoom-user-1');
      expect(logged).not.toHaveBeenCalled();
    });

    it('keeps a 2xx without an id as reason=profile', async () => {
      const fetchImpl = zoomFetch({ id: '' });
      const res = await (await startAndCallback({ fetchImpl })).promise;
      expect(res.headers.get('location')).toContain('reason=profile');
    });
  });

  describe('every outcome is recorded to PostHog', () => {
    const trackedEnv = { ...env, POSTHOG_API_KEY: 'phc_test' };

    function waitUntilCtx() {
      const pending = [];
      return { waitUntil: vi.fn((p) => pending.push(p)), settle: () => Promise.allSettled(pending) };
    }

    let logged;
    beforeEach(() => {
      logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => {
      logged.mockRestore();
    });

    it('records one web_signin_succeeded under the Zoom id, person-less, on success', async () => {
      const { promise, fetchImpl } = await startAndCallback({ callbackEnv: trackedEnv });
      const res = await promise;
      expect(res.headers.get('location')).toBe('https://www.example.test/account');

      const events = captures(fetchImpl);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        api_key: 'phc_test',
        event: 'web_signin_succeeded',
        properties: { distinct_id: 'zoom:zoom-user-1', $process_person_profile: false, surface: 'web' },
      });
    });

    it('records web_signin_failed and zoom_scope_not_granted for a missing scope, under one attempt id', async () => {
      const fetchImpl = zoomFetch({ meOk: false, meStatus: 400, meBody: MISSING_SCOPE_BODY, scope: 'zoomapp:inmeeting' });
      const { promise, nonce } = await startAndCallback({ callbackEnv: trackedEnv, fetchImpl });
      await promise;

      const events = captures(fetchImpl);
      expect(events.map((e) => e.event)).toEqual(['web_signin_failed', 'zoom_scope_not_granted']);
      const base = { distinct_id: `signin:${nonce}`, $process_person_profile: false, surface: 'web' };
      expect(events[0].properties).toEqual({
        ...base,
        reason: 'scope_not_granted',
        zoom_status: 400,
        zoom_code: 4711,
        scope_signal: 'both',
      });
      expect(events[1].properties).toEqual({ ...base, zoom_status: 400, zoom_code: 4711, scope_signal: 'both' });
    });

    it('records only web_signin_failed, with the Zoom status and code, for a bad token', async () => {
      const fetchImpl = zoomFetch({ meOk: false, meStatus: 401, meBody: BAD_TOKEN_BODY });
      await (await startAndCallback({ callbackEnv: trackedEnv, fetchImpl })).promise;

      const events = captures(fetchImpl);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        event: 'web_signin_failed',
        properties: { reason: 'profile', zoom_status: 401, zoom_code: 124 },
      });
      expect(events[0].properties).not.toHaveProperty('scope_signal');
    });

    it('records failures that never reach Zoom, with their reason', async () => {
      const mismatch = await startAndCallback({ callbackEnv: trackedEnv, withNonce: false });
      await mismatch.promise;
      expect(captures(mismatch.fetchImpl)).toEqual([
        expect.objectContaining({ event: 'web_signin_failed', properties: expect.objectContaining({ reason: 'state_mismatch' }) }),
      ]);

      const noCode = await startAndCallback({ callbackEnv: trackedEnv, code: null });
      await noCode.promise;
      expect(captures(noCode.fetchImpl).map((e) => e.properties.reason)).toEqual(['no_code']);

      const exchange = await startAndCallback({ callbackEnv: trackedEnv, fetchImpl: zoomFetch({ tokenOk: false }) });
      await exchange.promise;
      expect(captures(exchange.fetchImpl)).toEqual([
        expect.objectContaining({ properties: expect.objectContaining({ reason: 'exchange', zoom_status: 400 }) }),
      ]);
    });

    it('records nothing for a request that is not a sign-in', async () => {
      const { promise, fetchImpl } = await startAndCallback({ callbackEnv: trackedEnv, tamperState: true });
      expect(await promise).toBeNull();
      expect(captures(fetchImpl)).toEqual([]);
    });

    it('records nothing without a PostHog key', async () => {
      const { promise, fetchImpl } = await startAndCallback();
      await promise;
      expect(captures(fetchImpl)).toEqual([]);
    });

    it('hands the capture to ctx.waitUntil, so the redirect never waits on PostHog', async () => {
      // A PostHog that never answers: the callback must still resolve.
      const fetchImpl = zoomFetch({ posthog: () => new Promise(() => {}) });
      const ctx = waitUntilCtx();
      const res = await (await startAndCallback({ callbackEnv: trackedEnv, fetchImpl, ctx })).promise;

      expect(res.headers.get('location')).toBe('https://www.example.test/account');
      expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
      expect(captures(fetchImpl).map((e) => e.event)).toEqual(['web_signin_succeeded']);
    });

    it('hands both scope events to ctx.waitUntil', async () => {
      const fetchImpl = zoomFetch({ meOk: false, meStatus: 400, meBody: MISSING_SCOPE_BODY });
      const ctx = waitUntilCtx();
      const res = await (await startAndCallback({ callbackEnv: trackedEnv, fetchImpl, ctx })).promise;
      await ctx.settle();

      expect(res.headers.get('location')).toContain('reason=scope_not_granted');
      expect(ctx.waitUntil).toHaveBeenCalledTimes(2);
      expect(captures(fetchImpl).map((e) => e.event)).toEqual(['web_signin_failed', 'zoom_scope_not_granted']);
    });

    it('still redirects when PostHog is down', async () => {
      const fetchImpl = zoomFetch({
        posthog: () => {
          throw new Error('posthog down');
        },
      });
      const res = await (await startAndCallback({ callbackEnv: trackedEnv, fetchImpl })).promise;
      expect(res.headers.get('location')).toBe('https://www.example.test/account');
      expect(logged).toHaveBeenCalledWith('PostHog capture failed:', 'posthog down');
    });
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
