import crypto from 'node:crypto';
import { verifySessionToken, readBearerToken, mintSessionToken } from './session-token.js';
import { json, notConfigured, methodNotAllowed } from './http.js';

/**
 * Who is calling, and how the web app signs in.
 *
 * Two transports for the same signed session token:
 *  - Bearer header. The Zoom app keeps its token in sessionStorage; the token
 *    was minted from Zoom's encrypted app context, so no sign-in ever happens
 *    inside Zoom.
 *  - HttpOnly cookie. A plain browser has no Zoom context, so the web app signs
 *    in with Zoom (OAuth). The callback below exchanges the code server-side,
 *    reads the user's Zoom id — the same `uid` the app context carries — and
 *    mints the same kind of token into a cookie.
 *
 * One identity namespace, two doors. A subscription bought in Zoom is therefore
 * the same subscription on the web with nothing to link.
 */

export const SESSION_COOKIE = 'tt_session';
const OAUTH_COOKIE = 'tt_oauth';

/** Web sessions live longer than Zoom's 24h: nobody re-mints them on every load. */
export const WEB_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** A cookie older than this is re-issued on /api/me, so an active user never expires. */
export const REISSUE_AFTER_MS = 24 * 60 * 60 * 1000;
const STATE_TTL_MS = 10 * 60 * 1000;

const ZOOM_AUTHORIZE_URL = 'https://zoom.us/oauth/authorize';
const ZOOM_TOKEN_URL = 'https://zoom.us/oauth/token';
const ZOOM_ME_URL = 'https://api.zoom.us/v2/users/me';

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    out[name] = part.slice(eq + 1).trim();
  }
  return out;
}

function cookie(name, value, maxAgeSec) {
  // No Domain attribute: host-only, so a cookie set on the canonical web host
  // never leaks to the zoom.* host or to a sibling domain.
  return `${name}=${value}; Path=/; Max-Age=${maxAgeSec}; HttpOnly; Secure; SameSite=Lax`;
}

export const sessionCookie = (token, maxAgeSec = Math.floor(WEB_SESSION_TTL_MS / 1000)) =>
  cookie(SESSION_COOKIE, token, maxAgeSec);
export const clearSessionCookie = () => cookie(SESSION_COOKIE, '', 0);
const oauthCookie = (nonce) => cookie(OAUTH_COOKIE, nonce, Math.floor(STATE_TTL_MS / 1000));
const clearOauthCookie = () => cookie(OAUTH_COOKIE, '', 0);

// ---------------------------------------------------------------------------
// Session reading (both transports)
// ---------------------------------------------------------------------------

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Cookie-authenticated requests get the CSRF checks a bearer never needs:
 * SameSite=Lax already stops cross-site fetches from carrying the cookie, and
 * this is the second lock. Sec-Fetch-Site is sent by every current browser;
 * when present it must say same-origin (or none, for a typed URL). Mutations
 * with an Origin header must come from this host.
 */
function passesCsrf(request) {
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') return false;
  if (SAFE_METHODS.has(request.method)) return true;
  const origin = request.headers.get('origin');
  if (!origin) return true;
  try {
    return new URL(origin).host === (request.headers.get('host') || new URL(request.url).host);
  } catch {
    return false;
  }
}

/**
 * @param {Request} request
 * @param {Object} env - SESSION_SIGNING_KEY
 * @returns {{uid: string, exp: number, iat: number|null, via: 'bearer'|'cookie'}|null}
 */
export function readSession(request, env) {
  const bearer = readBearerToken(request);
  if (bearer) {
    const session = verifySessionToken(bearer, env.SESSION_SIGNING_KEY);
    return session ? { ...session, via: 'bearer' } : null;
  }

  const token = parseCookies(request.headers.get('cookie'))[SESSION_COOKIE];
  if (!token) return null;
  if (!passesCsrf(request)) return null;
  const session = verifySessionToken(token, env.SESSION_SIGNING_KEY);
  return session ? { ...session, via: 'cookie' } : null;
}

// ---------------------------------------------------------------------------
// OAuth state
// ---------------------------------------------------------------------------

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const hmac = (data, secret) => crypto.createHmac('sha256', secret).update(data).digest('base64url');

function signState(payload, secret) {
  const encoded = b64url(JSON.stringify(payload));
  return `${encoded}.${hmac(encoded, secret)}`;
}

export function verifyState(state, secret, now = Date.now()) {
  if (!state || typeof state !== 'string' || !secret) return null;
  const dot = state.indexOf('.');
  if (dot <= 0 || dot === state.length - 1) return null;
  const encoded = state.slice(0, dot);
  const signature = state.slice(dot + 1);
  const expected = hmac(encoded, secret);
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
  if (!payload || typeof payload.exp !== 'number' || payload.exp <= now) return null;
  if (typeof payload.nonce !== 'string' || !payload.nonce) return null;
  return payload;
}

/** Only same-site paths: "/app", "/account?x=1". Never a full URL or "//host". */
export function sanitizeReturnTo(value, fallback = '/app') {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) {
    return fallback;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function redirect(location, cookies = []) {
  const headers = new Headers({ Location: location, 'Cache-Control': 'private, no-store' });
  for (const c of cookies) headers.append('Set-Cookie', c);
  return new Response(null, { status: 302, headers });
}

/**
 * GET /api/auth/zoom/start?returnTo=/app — send the browser to Zoom.
 *
 * The state is signed and carries a nonce that is also set as a short-lived
 * cookie, so the callback can prove the browser that comes back is the one
 * that left. The redirect URI is always WEB_ORIGIN: that is the one registered
 * with Zoom, so sign-in always lands (and sets its cookie) on the canonical
 * web host, whichever host the user started from.
 */
export function handleAuthStart(request, url, env, { now = Date.now() } = {}) {
  if (request.method !== 'GET') return methodNotAllowed();
  if (!env.ZOOM_CLIENT_ID || !env.WEB_ORIGIN) return notConfigured('Sign in with Zoom');
  if (!env.SESSION_SIGNING_KEY) return notConfigured('Sign in with Zoom (signing key)');

  const returnTo = sanitizeReturnTo(url.searchParams.get('returnTo'));
  const nonce = b64url(crypto.randomBytes(16));
  const state = signState({ nonce, purpose: 'signin', returnTo, iat: now, exp: now + STATE_TTL_MS }, env.SESSION_SIGNING_KEY);

  const authorize = new URL(ZOOM_AUTHORIZE_URL);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('client_id', env.ZOOM_CLIENT_ID);
  authorize.searchParams.set('redirect_uri', `${env.WEB_ORIGIN}/oauth/redirect`);
  authorize.searchParams.set('state', state);

  return redirect(authorize.toString(), [oauthCookie(nonce)]);
}

/**
 * GET /oauth/redirect?code=…&state=… — Zoom sent the browser back.
 *
 * Returns null when this is not a sign-in (no state, or one we did not sign):
 * the Marketplace "Add" install flow uses the same redirect URI with no state,
 * and must keep landing on the SPA's install-success page. A session is never
 * set without a valid state; otherwise an attacker could complete an install
 * with their own code and log the victim's browser in as them.
 *
 * @returns {Promise<Response|null>}
 */
export async function handleOAuthCallback(request, url, env, { fetchImpl = fetch, now = Date.now() } = {}) {
  const state = url.searchParams.get('state');
  if (!state) return null;
  const payload = verifyState(state, env.SESSION_SIGNING_KEY, now);
  if (!payload || payload.purpose !== 'signin') return null;

  const returnTo = sanitizeReturnTo(payload.returnTo);
  const origin = env.WEB_ORIGIN || url.origin;
  const failed = (reason) => {
    const target = new URL(returnTo, origin);
    target.searchParams.set('signin', 'failed');
    target.searchParams.set('reason', reason);
    return redirect(target.toString(), [clearOauthCookie()]);
  };

  const nonce = parseCookies(request.headers.get('cookie'))[OAUTH_COOKIE];
  if (!nonce || nonce !== payload.nonce) return failed('state_mismatch');

  const code = url.searchParams.get('code');
  if (!code) return failed(url.searchParams.get('error') === 'access_denied' ? 'denied' : 'no_code');
  if (!env.ZOOM_CLIENT_ID || !env.ZOOM_CLIENT_SECRET) return failed('not_configured');

  try {
    const basic = Buffer.from(`${env.ZOOM_CLIENT_ID}:${env.ZOOM_CLIENT_SECRET}`).toString('base64');
    const tokenRes = await fetchImpl(ZOOM_TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: `${origin}/oauth/redirect`,
      }).toString(),
    });
    if (!tokenRes.ok) {
      console.error('Zoom token exchange failed:', tokenRes.status);
      return failed('exchange');
    }
    const tokens = await tokenRes.json();
    const accessToken = tokens?.access_token;
    if (!accessToken) return failed('exchange');

    const meRes = await fetchImpl(ZOOM_ME_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!meRes.ok) {
      // 400/401 here almost always means the app lacks the user:read scope.
      console.error('Zoom users/me failed:', meRes.status);
      return failed('profile');
    }
    const me = await meRes.json();
    const uid = typeof me?.id === 'string' && me.id ? me.id : null;
    if (!uid) return failed('profile');

    // The Zoom access/refresh tokens are dropped here on purpose: nothing calls
    // Zoom on the user's behalf later, and not storing them is less to protect.
    const session = mintSessionToken(uid, env.SESSION_SIGNING_KEY, now, WEB_SESSION_TTL_MS);
    if (!session) return failed('session');

    return redirect(new URL(returnTo, origin).toString(), [sessionCookie(session), clearOauthCookie()]);
  } catch (error) {
    console.error('Sign in with Zoom failed:', error?.message || error);
    return failed('network');
  }
}

/** POST /api/auth/logout — forget the web session. */
export function handleLogout(request) {
  if (request.method !== 'POST') return methodNotAllowed();
  return json({ signedOut: true }, 200, { 'Set-Cookie': clearSessionCookie() });
}
