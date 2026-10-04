import crypto from 'node:crypto';
import { parseCookies } from './auth.js';
import { json, methodNotAllowed, notConfigured } from './http.js';
import { entitlementStore, readClubRecord } from './entitlements.js';
import { clubByEmailKey, normalizeEmail } from './club-admin.js';
import { isEmailish } from './email.js';

/**
 * The console's second door: a link mailed to the club's billing address.
 *
 * Zoom sign-in is the everyday path and needs nothing new — roles are keyed by
 * Zoom uid and every buyer necessarily has one. This door exists for the case
 * Zoom sign-in cannot serve: the admin has moved on, or lost access. It
 * authenticates the **billing address** rather than a person, which is exactly
 * why it survives officer turnover — the address that paid outlives whoever
 * happened to hold the office.
 *
 *   POST /api/club/magic-link  { email }     rate-limited; ALWAYS 200
 *   GET|POST /api/club/manage?t=<token>      single use, 15-minute life
 *
 * The shape follows `handleOAuthCallback` (worker/auth.js): a short-lived
 * single-use token, and a redirect that falls through to the SPA when the
 * token is invalid rather than erroring at someone who clicked a stale link.
 */

/** Fifteen minutes. Long enough to walk to the laptop, short enough to matter. */
export const MAGIC_TTL_MS = 15 * 60 * 1000;

/**
 * Twelve hours for the session the link mints.
 *
 * Shorter than the 30-day web session on purpose: this one carries full admin
 * powers over a club and was authenticated by nothing but possession of an
 * inbox, so it is scoped to the sitting rather than to the browser.
 */
export const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export const ADMIN_COOKIE = 'tt_club_admin';

/** Where the console lives, and where a consumed link lands. */
export const CONSOLE_PATH = '/club/admin';
/** The SPA page that consumes `?t=`, and the page a bad link falls back to. */
export const MAGIC_PATH = '/club/manage';

const SEPARATOR = '.';

export const magicKey = (token) => `club-magic:${token}`;

// The address check lives in worker/email.js, shared with the Zoom contact
// record. Re-exported so existing importers of it from here keep working.
export { isEmailish };

// ---------------------------------------------------------------------------
// The link token, and the session it mints
// ---------------------------------------------------------------------------

/**
 * ~192 bits, base64url.
 *
 * Not Crockford base32 like the club codes and the share tokens: nobody reads a
 * magic link aloud or retypes it from a screenshot, so there is no O-for-zero
 * to design around and length is free.
 */
export function mintMagicToken(randomBytes = (n) => crypto.randomBytes(n)) {
  return Buffer.from(randomBytes(24)).toString('base64url');
}

const base64url = (buf) => Buffer.from(buf).toString('base64url');
const sign = (encoded, secret) => crypto.createHmac('sha256', secret).update(encoded).digest('base64url');

/**
 * Mint the console session a consumed link hands back.
 *
 * Same construction as session-token.js and club-token.js — one HMAC to
 * rotate, one set of failure modes to reason about — but a *third* credential
 * rather than a reuse of either: it names a club and an address, not a uid, and
 * folding it into the session token would mean every `readSession()` caller in
 * the Worker had to start asking which kind of session it got.
 *
 * @param {{clubId: string, email: string}} claims
 * @param {string} secret - SESSION_SIGNING_KEY
 * @returns {string|null}
 */
export function mintAdminSession({ clubId, email } = {}, secret, now = Date.now(), ttlMs = ADMIN_SESSION_TTL_MS) {
  if (!clubId || typeof clubId !== 'string' || !secret) return null;
  const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : ADMIN_SESSION_TTL_MS;
  const encoded = base64url(
    JSON.stringify({ clubId, email: normalizeEmail(email) || null, iat: now, exp: now + ttl })
  );
  return `${encoded}${SEPARATOR}${sign(encoded, secret)}`;
}

/**
 * Recover an admin session's claims, or null whenever it cannot be trusted.
 *
 * @returns {{clubId: string, email: string|null, iat: number|null, exp: number}|null}
 */
export function verifyAdminSession(token, secret, now = Date.now()) {
  if (!token || typeof token !== 'string' || !secret) return null;

  const at = token.indexOf(SEPARATOR);
  if (at <= 0 || at === token.length - 1) return null;
  const encoded = token.slice(0, at);
  const signature = token.slice(at + 1);

  const expected = sign(encoded, secret);
  // Length first: timingSafeEqual throws on differing sizes, and a length
  // mismatch is not a secret worth protecting.
  if (signature.length !== expected.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  } catch {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload.clubId !== 'string' || !payload.clubId) return null;
  if (typeof payload.exp !== 'number' || payload.exp <= now) return null;

  return {
    clubId: payload.clubId,
    email: typeof payload.email === 'string' ? payload.email : null,
    iat: typeof payload.iat === 'number' ? payload.iat : null,
    exp: payload.exp,
  };
}

/** Host-only, like the session cookie: it must never reach a sibling domain. */
const cookie = (value, maxAgeSec) =>
  `${ADMIN_COOKIE}=${value}; Path=/; Max-Age=${maxAgeSec}; HttpOnly; Secure; SameSite=Lax`;

export const adminSessionCookie = (token, maxAgeSec = Math.floor(ADMIN_SESSION_TTL_MS / 1000)) =>
  cookie(token, maxAgeSec);
export const clearAdminSessionCookie = () => cookie('', 0);

/**
 * The club this browser has been let into through the billing address, if any.
 *
 * @returns {{clubId: string, email: string|null}|null}
 */
export function readAdminSession(request, env, now = Date.now()) {
  const token = parseCookies(request.headers.get('cookie'))[ADMIN_COOKIE];
  if (!token) return null;
  return verifyAdminSession(token, env.SESSION_SIGNING_KEY, now);
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/** The address the mail comes from. Per-environment: dev has its own domain. */
const fromAddress = (env) => env.MAGIC_LINK_FROM || 'no-reply@toastmusters.com';

const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * Both bodies, always.
 *
 * HTML-only mail scores worse with spam filters and renders empty in text-only
 * clients — and this is the one message whose non-delivery locks somebody out.
 */
export function magicLinkBodies({ clubName, url }) {
  const club = clubName || 'your club';
  const text = [
    `Someone asked for an admin link for ${club} on Toastmusters Timer.`,
    '',
    'Open this link to manage your club:',
    url,
    '',
    'The link works once and expires in 15 minutes.',
    "If you didn't ask for it, you can ignore this message — nothing has changed.",
  ].join('\n');

  const html = `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#111827;line-height:1.5">
<p>Someone asked for an admin link for <strong>${escapeHtml(club)}</strong> on Toastmusters Timer.</p>
<p><a href="${escapeHtml(url)}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">Manage ${escapeHtml(club)}</a></p>
<p style="color:#6b7280;font-size:14px">The link works once and expires in 15 minutes.<br>If you didn't ask for it, you can ignore this message — nothing has changed.</p>
<p style="color:#6b7280;font-size:12px;word-break:break-all">${escapeHtml(url)}</p>
</body></html>`;

  return { text, html };
}

/**
 * Put the link in the post.
 *
 * Never throws. Two failure modes are handled here rather than discovered:
 *
 *  - A billing address that hard-bounces once is **permanently suppressed** on
 *    the account, and every later send returns `E_RECIPIENT_SUPPRESSED`. So a
 *    magic link can fail silently forever, and the person who would report it
 *    is the one locked out. The console's "we've sent you a link" state is
 *    therefore never proof of delivery, and this logs loudly enough to act on.
 *  - No binding at all (local `wrangler dev` without `send_email`) is a
 *    configuration fact, not an incident, and says so separately.
 *
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function sendMagicLink(env, { email, clubName, url }) {
  if (!env.EMAIL?.send) {
    console.error('Club magic link not sent: no EMAIL binding is configured');
    return { ok: false, error: 'not_configured' };
  }

  const { text, html } = magicLinkBodies({ clubName, url });
  try {
    await env.EMAIL.send({
      to: email,
      from: { email: fromAddress(env), name: 'Toastmusters Timer' },
      subject: `Your ${clubName || 'club'} admin link`,
      html,
      text,
    });
    return { ok: true };
  } catch (error) {
    const reason = error?.code || error?.name || 'send_failed';
    if (String(error?.message || error?.code || '').includes('E_RECIPIENT_SUPPRESSED')) {
      // A permanent state, not a blip: this address will never receive another
      // message until it is taken off the account's suppression list by hand.
      console.error(
        `Club magic link suppressed for ${email}: the address is on the account suppression list ` +
          'after an earlier hard bounce. It must be removed by hand; retrying will not help.'
      );
      return { ok: false, error: 'suppressed' };
    }
    console.error('Club magic link send failed:', reason, error?.message || error);
    return { ok: false, error: 'send_failed' };
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** Shared with activation's limiter, in its own bucket, so no new binding. */
async function throttled(request, env) {
  if (!env.CLUB_ACTIVATE_LIMITER?.limit) return false;
  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';
  try {
    const { success } = await env.CLUB_ACTIVATE_LIMITER.limit({ key: `magic:${ip}` });
    return !success;
  } catch {
    // A limiter that is down must not take the recovery door down with it.
    return false;
  }
}

function origin(request, env) {
  if (typeof env?.WEB_ORIGIN === 'string' && env.WEB_ORIGIN) return env.WEB_ORIGIN.replace(/\/+$/, '');
  try {
    return new URL(request.url).origin;
  } catch {
    return '';
  }
}

async function readJsonBody(request) {
  try {
    return (await request.json()) ?? {};
  } catch {
    return {};
  }
}

/**
 * POST /api/club/magic-link — mail an admin link to a club's billing address.
 *
 * Always answers 200, whether or not the address owns anything. Otherwise the
 * endpoint becomes an oracle for "which address bought this club", which is the
 * same reasoning that gives code activation one uniform failure.
 */
export async function handleMagicLinkRequest(request, env) {
  if (request.method !== 'POST') return methodNotAllowed();
  if (!env.SESSION_SIGNING_KEY) return notConfigured('Club admin links');

  if (await throttled(request, env)) return json({ error: 'too_many_attempts' }, 429);

  // The same body for every outcome, minted before any lookup so the two paths
  // cannot be told apart by the shape of the answer.
  const sent = () => json({ sent: true });

  const body = await readJsonBody(request);
  const email = normalizeEmail(body?.email);
  if (!isEmailish(email)) return sent();

  const store = entitlementStore(env);
  if (!store) return sent();

  const clubId = await store.get(clubByEmailKey(email)).catch(() => null);
  if (!clubId) return sent();

  const club = await readClubRecord(env, clubId);
  // A renamed or re-billed club: the index is stale, so treat it as no match.
  if (!club || normalizeEmail(club.billingEmail) !== email) return sent();

  const token = mintMagicToken();
  const now = Date.now();
  await store.put(
    magicKey(token),
    JSON.stringify({ clubId, email, createdAt: now, exp: now + MAGIC_TTL_MS }),
    // Belt and braces: the handler checks `exp` itself, and the TTL means a
    // token nobody clicks does not sit in KV forever waiting to be guessed.
    { expirationTtl: Math.ceil(MAGIC_TTL_MS / 1000) }
  );

  const url = `${origin(request, env)}${MAGIC_PATH}?t=${encodeURIComponent(token)}`;
  // Awaited: the send is the whole point of the request, and a failure has to
  // be logged from inside it rather than after the response has gone.
  await sendMagicLink(env, { email, clubName: club.name, url });

  return sent();
}

const redirect = (location, cookies = []) => {
  const headers = new Headers({ Location: location, 'Cache-Control': 'private, no-store' });
  for (const value of cookies) headers.append('Set-Cookie', value);
  return new Response(null, { status: 302, headers });
};

/**
 * GET|POST /api/club/manage?t=<token> — spend the link, take the session.
 *
 * GET redirects, the way the OAuth callback does, so a pasted link works on its
 * own. The SPA page uses POST, because an email client that prefetches links
 * would otherwise spend a single-use token before the officer ever clicked it.
 *
 * An invalid or expired token falls through to the SPA with a reason rather
 * than erroring: the person holding a stale link needs a way to ask for a fresh
 * one, not a 400.
 */
export async function handleClubManage(request, url, env) {
  if (request.method !== 'GET' && request.method !== 'POST') return methodNotAllowed();
  if (!env.SESSION_SIGNING_KEY) return notConfigured('Club admin links');

  const base = origin(request, env);
  const wantsJson = request.method === 'POST';
  const failed = (reason) =>
    wantsJson
      ? json({ error: reason }, 400, { 'Set-Cookie': clearAdminSessionCookie() })
      : redirect(`${base}${MAGIC_PATH}?error=${reason}`, [clearAdminSessionCookie()]);

  const token = url.searchParams.get('t') || (wantsJson ? (await readJsonBody(request))?.t : null);
  if (!token || typeof token !== 'string') return failed('invalid_link');

  const store = entitlementStore(env);
  if (!store) return failed('invalid_link');

  const record = await store.get(magicKey(token), 'json').catch(() => null);
  if (!record?.clubId) return failed('invalid_link');

  const now = Date.now();
  // Spent on sight, before anything else can fail: a link that was looked at
  // is a link that is gone, so a replayed URL never mints a second session.
  await store.delete(magicKey(token)).catch(() => {});
  if (typeof record.exp === 'number' && record.exp <= now) return failed('expired');

  const club = await readClubRecord(env, record.clubId);
  if (!club) return failed('invalid_link');

  const session = mintAdminSession({ clubId: record.clubId, email: record.email }, env.SESSION_SIGNING_KEY, now);
  if (!session) return failed('invalid_link');

  const payload = {
    ok: true,
    club: { id: record.clubId, name: club.name ?? null },
    actor: { type: 'billing', email: record.email ?? null },
    expiresAt: now + ADMIN_SESSION_TTL_MS,
  };

  return wantsJson
    ? json(payload, 200, { 'Set-Cookie': adminSessionCookie(session) })
    : redirect(`${base}${CONSOLE_PATH}`, [adminSessionCookie(session)]);
}

/** POST /api/club/manage/signout — drop the billing-address session. */
export function handleClubManageSignOut(request) {
  if (request.method !== 'POST') return methodNotAllowed();
  return json({ signedOut: true }, 200, { 'Set-Cookie': clearAdminSessionCookie() });
}
