import { describe, it, expect, vi, afterEach } from 'vitest';
import { contactKey, saveZoomContact, readContactKnown, handleZoomContact } from './contact.js';
import { mintSessionToken } from './session-token.js';

const SIGNING_KEY = 'test-session-signing-key';
const NOW = 1_800_000_000_000;
const UID = 'zoom-user-1';
const KEY = 'contact:zoom:zoom-user-1';
const VERIFIER = 'v'.repeat(64);

function makeKv(seed = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  return {
    store,
    get: async (key, type) => {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    put: vi.fn(async (key, value) => { store.set(key, value); }),
    delete: async (key) => { store.delete(key); },
  };
}

const zoomMe = (over = {}) => ({ id: UID, email: 'Sarah@Example.com', first_name: 'Sarah', last_name: 'Smith', ...over });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('contactKey', () => {
  it('names the record by Zoom uid', () => {
    expect(contactKey(UID)).toBe(KEY);
  });
});

describe('saveZoomContact', () => {
  it('saves a first record with a normalised email and the names', async () => {
    const kv = makeKv();
    expect(await saveZoomContact({ PROFILES: kv }, UID, zoomMe(), NOW)).toEqual({ saved: true });
    expect(JSON.parse(kv.store.get(KEY))).toEqual({
      email: 'sarah@example.com', firstName: 'Sarah', lastName: 'Smith', updatedAt: NOW,
    });
  });

  it('writes nothing when the merged record is the one already stored', async () => {
    const kv = makeKv();
    await saveZoomContact({ PROFILES: kv }, UID, zoomMe(), NOW);
    const before = kv.store.get(KEY);

    expect(await saveZoomContact({ PROFILES: kv }, UID, zoomMe({ email: ' SARAH@example.com ' }), NOW + 1000))
      .toEqual({ saved: false, reason: 'unchanged' });
    expect(kv.store.get(KEY)).toBe(before);
    expect(kv.put).toHaveBeenCalledTimes(1);
  });

  it('updates a changed email and keeps the stored names when Zoom sends none', async () => {
    const kv = makeKv({ [KEY]: { email: 'old@example.com', firstName: 'Sarah', lastName: 'Smith', updatedAt: 1 } });

    expect(await saveZoomContact({ PROFILES: kv }, UID, { id: UID, email: 'new@example.com' }, NOW)).toEqual({ saved: true });
    expect(JSON.parse(kv.store.get(KEY))).toEqual({
      email: 'new@example.com', firstName: 'Sarah', lastName: 'Smith', updatedAt: NOW,
    });
  });

  it('never replaces a stored email with an empty or invalid one', async () => {
    const stored = { email: 'kept@example.com', firstName: 'Sarah', lastName: 'Smith', updatedAt: 1 };
    for (const email of ['', '   ', 'not-an-email', null, undefined]) {
      const kv = makeKv({ [KEY]: stored });
      const result = await saveZoomContact({ PROFILES: kv }, UID, zoomMe({ email }), NOW);
      expect(result, String(email)).toEqual({ saved: false, reason: 'unchanged' });
      expect(JSON.parse(kv.store.get(KEY)).email).toBe('kept@example.com');
    }
  });

  it('stores names with a null email when Zoom has no valid email', async () => {
    const kv = makeKv();
    expect(await saveZoomContact({ PROFILES: kv }, UID, zoomMe({ email: '' }), NOW)).toEqual({ saved: true });
    expect(JSON.parse(kv.store.get(KEY))).toMatchObject({ email: null, firstName: 'Sarah', lastName: 'Smith' });
  });

  it('writes nothing at all when Zoom sent nothing usable', async () => {
    const kv = makeKv();
    expect(await saveZoomContact({ PROFILES: kv }, UID, { id: UID, email: 'x', first_name: '  ', last_name: 7 }, NOW))
      .toEqual({ saved: false, reason: 'empty' });
    expect(kv.store.has(KEY)).toBe(false);
  });

  it('reports an unbound namespace instead of throwing', async () => {
    expect(await saveZoomContact({}, UID, zoomMe(), NOW)).toEqual({ saved: false, reason: 'unbound' });
  });

  // Every caller wraps it: the sign-in callback in a .catch, the endpoint in a
  // try that answers 503. It must not swallow the failure itself.
  it('rejects when the write fails', async () => {
    const kv = makeKv();
    kv.put = async () => { throw new Error('kv down'); };
    await expect(saveZoomContact({ PROFILES: kv }, UID, zoomMe(), NOW)).rejects.toThrow('kv down');
  });
});

describe('readContactKnown', () => {
  it('is true only when a record exists', async () => {
    expect(await readContactKnown({ PROFILES: makeKv({ [KEY]: { email: 'a@b.co' } }) }, UID)).toBe(true);
    expect(await readContactKnown({ PROFILES: makeKv() }, UID)).toBe(false);
  });

  it('is false when unbound or when the read fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await readContactKnown({}, UID)).toBe(false);
    expect(await readContactKnown({ PROFILES: { get: async () => { throw new Error('kv down'); } } }, UID)).toBe(false);
  });
});

describe('handleZoomContact', () => {
  const baseEnv = (over = {}) => ({
    SESSION_SIGNING_KEY: SIGNING_KEY,
    ZOOM_CLIENT_ID: 'client-id',
    ZOOM_CLIENT_SECRET: 'client-secret',
    ZOOM_APP_HOME_URL: 'https://zoom.example.test',
    PROFILES: makeKv(),
    ...over,
  });

  function zoomFetch({ tokenOk = true, meOk = true, me = zoomMe(), tokenThrows = false } = {}) {
    return vi.fn(async (url) => {
      if (String(url).startsWith('https://zoom.us/oauth/token')) {
        if (tokenThrows) throw new Error('network down');
        return new Response(JSON.stringify(tokenOk ? { access_token: 'at', refresh_token: 'rt' } : { error: 'invalid_grant' }), { status: tokenOk ? 200 : 400 });
      }
      if (String(url).startsWith('https://api.zoom.us/v2/users/me')) {
        return new Response(JSON.stringify(meOk ? me : {}), { status: meOk ? 200 : 401 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
  }

  function request({ uid = UID, body = { code: 'the-code', codeVerifier: VERIFIER }, method = 'POST', token } = {}) {
    const headers = { 'content-type': 'application/json' };
    const bearer = token === undefined ? mintSessionToken(uid, SIGNING_KEY) : token;
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    return new Request('https://zoom.example.test/api/zoom/contact', {
      method,
      headers,
      ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    });
  }

  it('exchanges the code with the verifier and the Home URL, checks the uid and saves the contact', async () => {
    const env = baseEnv();
    const fetchImpl = zoomFetch();
    const res = await handleZoomContact(request(), env, { fetchImpl, now: NOW });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ saved: true });
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');

    const [tokenUrl, init] = fetchImpl.mock.calls[0];
    expect(tokenUrl).toBe('https://zoom.us/oauth/token');
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from('client-id:client-secret').toString('base64')}`);
    const form = new URLSearchParams(init.body);
    expect(Object.fromEntries(form)).toEqual({
      grant_type: 'authorization_code',
      code: 'the-code',
      redirect_uri: 'https://zoom.example.test',
      code_verifier: VERIFIER,
    });
    expect(fetchImpl.mock.calls[1][1].headers.Authorization).toBe('Bearer at');

    expect(JSON.parse(env.PROFILES.store.get(KEY))).toEqual({
      email: 'sarah@example.com', firstName: 'Sarah', lastName: 'Smith', updatedAt: NOW,
    });
  });

  // The answer is the only thing the client sees; it must not carry the email.
  it('never returns the contact, even when nothing changed', async () => {
    const env = baseEnv({ PROFILES: makeKv({ [KEY]: { email: 'sarah@example.com', firstName: 'Sarah', lastName: 'Smith', updatedAt: 1 } }) });
    const res = await handleZoomContact(request(), env, { fetchImpl: zoomFetch(), now: NOW });
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ saved: false });
    expect(text).not.toContain('example.com');
  });

  it('refuses anything but POST', async () => {
    const res = await handleZoomContact(request({ method: 'GET' }), baseEnv(), { fetchImpl: zoomFetch() });
    expect(res.status).toBe(405);
  });

  it('answers 401 without a valid session, before touching Zoom', async () => {
    const fetchImpl = zoomFetch();
    expect((await handleZoomContact(request({ token: null }), baseEnv(), { fetchImpl })).status).toBe(401);
    expect((await handleZoomContact(request({ token: 'forged.token' }), baseEnv(), { fetchImpl })).status).toBe(401);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('answers 400 to a body it cannot use, before touching Zoom', async () => {
    const fetchImpl = zoomFetch();
    for (const body of [
      'not json',
      {},
      { code: 'c' },
      { code: '', codeVerifier: VERIFIER },
      { code: 7, codeVerifier: VERIFIER },
      { code: 'c', codeVerifier: 'too-short' },
      { code: 'c', codeVerifier: `${'v'.repeat(60)} bad` },
      { code: 'c'.repeat(3000), codeVerifier: VERIFIER },
    ]) {
      const res = await handleZoomContact(request({ body }), baseEnv(), { fetchImpl });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('answers 503 when storage or the Zoom credentials are missing', async () => {
    const fetchImpl = zoomFetch();
    expect((await handleZoomContact(request(), baseEnv({ PROFILES: undefined }), { fetchImpl })).status).toBe(503);
    expect((await handleZoomContact(request(), baseEnv({ ZOOM_CLIENT_SECRET: undefined }), { fetchImpl })).status).toBe(503);
    expect((await handleZoomContact(request(), baseEnv({ ZOOM_APP_HOME_URL: undefined }), { fetchImpl })).status).toBe(503);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('answers 502 exchange when Zoom refuses the code or cannot be reached', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const fetchImpl of [zoomFetch({ tokenOk: false }), zoomFetch({ tokenThrows: true })]) {
      const env = baseEnv();
      const res = await handleZoomContact(request(), env, { fetchImpl });
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: 'exchange' });
      expect(env.PROFILES.store.size).toBe(0);
    }
  });

  // Before the user:read:user scope is granted, users/me is what fails.
  it('answers 502 profile when users/me fails or names nobody', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const fetchImpl of [zoomFetch({ meOk: false }), zoomFetch({ me: { email: 'a@b.co' } })]) {
      const env = baseEnv();
      const res = await handleZoomContact(request(), env, { fetchImpl });
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: 'profile' });
      expect(env.PROFILES.store.size).toBe(0);
    }
  });

  it('answers 403 and saves nothing when the code belongs to another Zoom account', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const env = baseEnv();
    const res = await handleZoomContact(request(), env, { fetchImpl: zoomFetch({ me: zoomMe({ id: 'someone-else' }) }) });

    expect(res.status).toBe(403);
    expect(env.PROFILES.store.size).toBe(0);
  });

  it('answers 503 when the write fails, so the app backs off', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const kv = makeKv();
    kv.put = async () => { throw new Error('kv down'); };
    const res = await handleZoomContact(request(), baseEnv({ PROFILES: kv }), { fetchImpl: zoomFetch() });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'storage' });
  });
});
