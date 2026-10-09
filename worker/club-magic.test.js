import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ADMIN_COOKIE,
  ADMIN_SESSION_TTL_MS,
  MAGIC_TTL_MS,
  handleMagicLinkRequest,
  handleClubManage,
  handleClubManageSignOut,
  magicKey,
  magicLinkBodies,
  mintAdminSession,
  readAdminSession,
  sendMagicLink,
  verifyAdminSession,
} from './club-magic.js';
import { createClubFromPending, clubByEmailKey } from './club-admin.js';

/**
 * The console's second door.
 *
 * Two properties carry the whole design: the request endpoint tells you nothing
 * about which address owns a club, and the link it mails is worth exactly one
 * use inside fifteen minutes.
 */

const SIGNING_KEY = 'test-session-signing-key';
const BILLING_EMAIL = 'treasurer@downtownspeakers.org';

function makeKv(seed = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  return {
    store,
    get: async (key, type) => {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    put: async (key, value) => { store.set(key, value); },
    delete: async (key) => { store.delete(key); },
    list: async ({ prefix = '' } = {}) => ({
      keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
      list_complete: true,
    }),
  };
}

/** The send_email binding, recording what it was handed. */
function makeEmail(impl) {
  const sent = [];
  return {
    sent,
    send: async (message) => {
      sent.push(message);
      if (impl) return impl(message);
      return undefined;
    },
  };
}

let kv;
let env;
let email;

beforeEach(() => {
  kv = makeKv();
  email = makeEmail();
  env = {
    PROFILES: kv,
    EMAIL: email,
    SESSION_SIGNING_KEY: SIGNING_KEY,
    WEB_ORIGIN: 'https://www.timer.simple-tech.app',
    MAGIC_LINK_FROM: 'no-reply@toastmusters.com',
    ENTITLEMENT_ENFORCE: '1',
  };
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const requestLink = (address, { ip = '1.2.3.4' } = {}) =>
  new Request('https://x/api/club/magic-link', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({ email: address }),
  });

const seedClub = () =>
  createClubFromPending(
    env,
    { clubName: 'Downtown Speakers', uid: 'buyer-uid', email: BILLING_EMAIL },
    { code: 'DTSP7K2QM9' }
  );

/** The token the mailed link carries. */
function tokenFromLink() {
  const body = email.sent.at(-1)?.text ?? '';
  const match = /\/club\/manage\?t=([^\s]+)/.exec(body);
  return match ? decodeURIComponent(match[1]) : null;
}

const manageUrl = (token) => new URL(`https://x/api/club/manage?t=${encodeURIComponent(token ?? '')}`);
const manageGet = (token) => new Request(manageUrl(token));
const managePost = (token) => new Request(manageUrl(token), { method: 'POST' });

// ---------------------------------------------------------------------------

describe('POST /api/club/magic-link', () => {
  it('mails a link to the address that owns the club', async () => {
    await seedClub();

    const res = await handleMagicLinkRequest(requestLink(BILLING_EMAIL), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: true });

    expect(email.sent).toHaveLength(1);
    const message = email.sent[0];
    expect(message.to).toBe(BILLING_EMAIL);
    expect(message.from).toMatchObject({ email: 'no-reply@toastmusters.com' });
    expect(message.subject).toContain('Downtown Speakers');
    // Both bodies, always: HTML-only mail scores worse with filters and renders
    // empty in text-only clients, and this is the message that unlocks a club.
    expect(message.html).toContain('Downtown Speakers');
    expect(message.text).toContain('https://www.timer.simple-tech.app/club/manage?t=');
  });

  // The whole point of answering the same way twice: the endpoint must not be
  // an oracle for "which address bought this club".
  it('answers identically for an address that owns nothing, and sends nothing', async () => {
    await seedClub();

    const owner = await handleMagicLinkRequest(requestLink(BILLING_EMAIL), env);
    const stranger = await handleMagicLinkRequest(requestLink('nobody@example.com', { ip: '5.6.7.8' }), env);

    expect(stranger.status).toBe(owner.status);
    expect(await stranger.json()).toEqual(await owner.json());
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0].to).toBe(BILLING_EMAIL);
  });

  it('answers the same way for a malformed address', async () => {
    const res = await handleMagicLinkRequest(requestLink('not-an-address'), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: true });
    expect(email.sent).toHaveLength(0);
  });

  it('matches the address whatever case it was typed in', async () => {
    await seedClub();

    await handleMagicLinkRequest(requestLink('  TREASURER@DowntownSpeakers.ORG '), env);
    expect(email.sent).toHaveLength(1);
  });

  // A stale index (the club was re-billed to another address) must not let the
  // old address back in.
  it('refuses when the index no longer agrees with the club record', async () => {
    const { clubId } = await seedClub();
    const club = await kv.get(`club:${clubId}`, 'json');
    await kv.put(`club:${clubId}`, JSON.stringify({ ...club, billingEmail: 'someone-else@example.com' }));

    await handleMagicLinkRequest(requestLink(BILLING_EMAIL), env);
    expect(email.sent).toHaveLength(0);
  });

  it('is throttled in its own bucket, not activation\'s', async () => {
    await seedClub();
    const keys = [];
    env.CLUB_ACTIVATE_LIMITER = {
      limit: async ({ key }) => {
        keys.push(key);
        return { success: keys.length <= 2 };
      },
    };

    expect((await handleMagicLinkRequest(requestLink(BILLING_EMAIL), env)).status).toBe(200);
    expect((await handleMagicLinkRequest(requestLink(BILLING_EMAIL), env)).status).toBe(200);
    expect((await handleMagicLinkRequest(requestLink(BILLING_EMAIL), env)).status).toBe(429);
    expect(keys.every((key) => key.startsWith('magic:'))).toBe(true);
  });

  it('stores the token with a TTL so an unclicked link does not linger', async () => {
    await seedClub();
    const puts = [];
    const put = kv.put;
    kv.put = async (key, value, options) => {
      puts.push({ key, options });
      return put(key, value);
    };

    await handleMagicLinkRequest(requestLink(BILLING_EMAIL), env);
    const tokenPut = puts.find((entry) => entry.key.startsWith('club-magic:'));
    expect(tokenPut?.options?.expirationTtl).toBe(MAGIC_TTL_MS / 1000);
  });
});

describe('sendMagicLink', () => {
  it('logs a suppressed recipient loudly, and reports it', async () => {
    env.EMAIL = makeEmail(() => {
      throw Object.assign(new Error('E_RECIPIENT_SUPPRESSED: recipient is suppressed'), {
        code: 'E_RECIPIENT_SUPPRESSED',
      });
    });

    const result = await sendMagicLink(env, { email: BILLING_EMAIL, clubName: 'Downtown Speakers', url: 'https://x/club/manage?t=abc' });

    expect(result).toEqual({ ok: false, error: 'suppressed' });
    const logged = console.error.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(logged).toContain('suppress');
    expect(logged).toContain(BILLING_EMAIL);
  });

  it('never lets a send failure reach the caller as an exception', async () => {
    env.EMAIL = makeEmail(() => {
      throw new Error('network down');
    });
    await expect(
      sendMagicLink(env, { email: BILLING_EMAIL, clubName: 'Downtown Speakers', url: 'https://x' })
    ).resolves.toEqual({ ok: false, error: 'send_failed' });
  });

  it('says so when there is no binding at all', async () => {
    delete env.EMAIL;
    await expect(sendMagicLink(env, { email: BILLING_EMAIL, url: 'https://x' })).resolves.toEqual({
      ok: false,
      error: 'not_configured',
    });
  });

  // A failed send must never change the answer the requester sees.
  it('still answers 200 when the send fails', async () => {
    await seedClub();
    env.EMAIL = makeEmail(() => {
      throw new Error('nope');
    });

    const res = await handleMagicLinkRequest(requestLink(BILLING_EMAIL), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: true });
  });

  it('escapes the club name in the HTML body', () => {
    const { html, text } = magicLinkBodies({ clubName: '<script>Bad</script>', url: 'https://x?a=1&b=2' });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('a=1&amp;b=2');
    expect(text).toContain('https://x?a=1&b=2');
  });
});

describe('GET/POST /api/club/manage', () => {
  it('spends the token and hands back an admin session', async () => {
    const { clubId } = await seedClub();
    await handleMagicLinkRequest(requestLink(BILLING_EMAIL), env);
    const token = tokenFromLink();

    const res = await handleClubManage(managePost(token), manageUrl(token), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      club: { id: clubId, name: 'Downtown Speakers' },
      actor: { type: 'billing', email: BILLING_EMAIL },
    });

    const cookie = res.headers.get('set-cookie');
    expect(cookie).toMatch(new RegExp(`^${ADMIN_COOKIE}=`));
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');

    const claims = verifyAdminSession(cookie.slice(`${ADMIN_COOKIE}=`.length).split(';')[0], SIGNING_KEY);
    expect(claims).toMatchObject({ clubId, email: BILLING_EMAIL });
  });

  it('redirects a plain click straight into the console', async () => {
    await seedClub();
    await handleMagicLinkRequest(requestLink(BILLING_EMAIL), env);
    const token = tokenFromLink();

    const res = await handleClubManage(manageGet(token), manageUrl(token), env);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://www.timer.simple-tech.app/club/admin');
    expect(res.headers.get('set-cookie')).toMatch(new RegExp(`^${ADMIN_COOKIE}=`));
  });

  it('cannot be used twice', async () => {
    await seedClub();
    await handleMagicLinkRequest(requestLink(BILLING_EMAIL), env);
    const token = tokenFromLink();

    expect((await handleClubManage(managePost(token), manageUrl(token), env)).status).toBe(200);

    const replay = await handleClubManage(managePost(token), manageUrl(token), env);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({ error: 'invalid_link' });
    expect(kv.store.has(magicKey(token))).toBe(false);
  });

  // "Falls through to the SPA rather than erroring": the person holding a stale
  // link needs a way to ask for a fresh one, not a 400 page.
  it('sends an expired link back to the SPA with a reason', async () => {
    const { clubId } = await seedClub();
    await kv.put(magicKey('stale'), JSON.stringify({ clubId, email: BILLING_EMAIL, exp: Date.now() - 1 }));

    const res = await handleClubManage(manageGet('stale'), manageUrl('stale'), env);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://www.timer.simple-tech.app/club/manage?error=expired');
    // And it is spent regardless, so a stale link cannot be retried into life.
    expect(kv.store.has(magicKey('stale'))).toBe(false);
  });

  it('sends an unknown token back to the SPA too', async () => {
    const res = await handleClubManage(manageGet('nope'), manageUrl('nope'), env);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/club/manage?error=invalid_link');
  });

  it('refuses a token whose club has gone', async () => {
    await kv.put(magicKey('orphan'), JSON.stringify({ clubId: 'missing', email: BILLING_EMAIL, exp: Date.now() + 1e6 }));
    const res = await handleClubManage(managePost('orphan'), manageUrl('orphan'), env);
    expect(res.status).toBe(400);
  });

  it('signs the billing session out again', async () => {
    const res = handleClubManageSignOut(new Request('https://x/api/club/manage/signout', { method: 'POST' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toContain(`${ADMIN_COOKIE}=;`);
  });
});

describe('the admin session token', () => {
  it('round-trips and expires', () => {
    const now = 1_700_000_000_000;
    const token = mintAdminSession({ clubId: 'club-1', email: 'A@B.com' }, SIGNING_KEY, now);
    expect(verifyAdminSession(token, SIGNING_KEY, now + 1000)).toMatchObject({
      clubId: 'club-1',
      email: 'a@b.com',
    });
    expect(verifyAdminSession(token, SIGNING_KEY, now + ADMIN_SESSION_TTL_MS + 1)).toBeNull();
  });

  it('refuses a token signed with another key, and a tampered one', () => {
    const token = mintAdminSession({ clubId: 'club-1', email: BILLING_EMAIL }, SIGNING_KEY);
    expect(verifyAdminSession(token, 'another-key')).toBeNull();
    expect(verifyAdminSession(`${token}x`, SIGNING_KEY)).toBeNull();
    expect(verifyAdminSession(token.replace(/^./, 'A'), SIGNING_KEY)).toBeNull();
    expect(verifyAdminSession('', SIGNING_KEY)).toBeNull();
    expect(verifyAdminSession(token, undefined)).toBeNull();
  });

  it('is read off the cookie', () => {
    const token = mintAdminSession({ clubId: 'club-9', email: BILLING_EMAIL }, SIGNING_KEY);
    const request = new Request('https://x/api/club/roster', {
      headers: { cookie: `other=1; ${ADMIN_COOKIE}=${token}` },
    });
    expect(readAdminSession(request, env)).toMatchObject({ clubId: 'club-9' });
    expect(readAdminSession(new Request('https://x/api/club/roster'), env)).toBeNull();
  });
});

describe('the billing-address index', () => {
  it('is written when the club is created', async () => {
    const { clubId } = await seedClub();
    expect(await kv.get(clubByEmailKey(BILLING_EMAIL))).toBe(clubId);
  });
});
