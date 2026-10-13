import { parseCookies, hostOnlyCookie } from './auth.js';

/**
 * The "approved before" mark, and the two redirects that write and read it
 * (GitHub issue #96).
 *
 * When a user's Zoom authorization lapses, Zoom sends them to our website with
 * no explanation. To greet them as someone coming back rather than as a
 * stranger, the browser is marked once it has added the app from our site:
 *
 *   tt_approved=1; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax
 *
 * Set by the Worker only, on an install or re-approval landing
 * (/oauth/redirect?code with no state), and read by the Worker only: there,
 * and on a bare / (sent to the reconnect page). It means "approved once",
 * never "lapsed now": the website cannot tell whether a grant is still alive.
 * Web sign-in does not write it, because people who sign in on the web are
 * mostly web-timer users, and their homepage visits should stay the homepage.
 *
 * Server-set on purpose. Safari caps cookies written by page JavaScript at 7
 * days, and a lapse arrives about 90 days after a scope change. And the one
 * request that writes the mark can also see whether it was already there, so
 * the success page knows "reconnected" from "first install" with no race.
 *
 * Neither identity nor sign-in, so it lives here beside contact.js rather than
 * in auth.js. The one thing it borrows is the host-only cookie template.
 */

export const APPROVED_COOKIE = 'tt_approved';
const APPROVED_TTL_SEC = 365 * 24 * 60 * 60;

/** Whether this request carries the mark. */
export function approvedBefore(request) {
  return parseCookies(request.headers.get('cookie'))[APPROVED_COOKIE] === '1';
}

/**
 * /oauth/redirect?code=… with no state — answer with a clean URL that names
 * the outcome, and mark the browser.
 *
 *   302 Location: <origin>/oauth/redirect?welcome=back   the request carried the mark
 *                 <origin>/oauth/redirect?welcome=new    it did not
 *       Set-Cookie: tt_approved=1 (one year, host-only)
 *       Cache-Control: no-store
 *
 * Zoom's one-time code leaves the address bar before the page loads, so it
 * never reaches browser history or an analytics pageview. The caller has
 * already handed the original URL to captureInstallContact, which spends the
 * code in the background exactly as before.
 *
 * Null on the zoom.* host, which keeps serving the Zoom shell for every path.
 * Null means "fall through", the contract handleOAuthCallback uses at the same
 * spot in index.js.
 *
 * A plain Response rather than Response.redirect(), whose headers are
 * immutable, because there is a cookie to set.
 *
 * @param {Request} request
 * @param {URL} url
 * @returns {Response|null}
 */
export function installLandingRedirect(request, url) {
  const host = request.headers.get('host') || url.host;
  if (host.startsWith('zoom.')) return null;

  const target = new URL('/oauth/redirect', url.origin);
  target.searchParams.set('welcome', approvedBefore(request) ? 'back' : 'new');

  const headers = new Headers({ Location: target.toString(), 'Cache-Control': 'no-store' });
  headers.append('Set-Cookie', hostOnlyCookie(APPROVED_COOKIE, '1', APPROVED_TTL_SEC));
  return new Response(null, { status: 302, headers });
}

/**
 * A bare / from a browser that carries the mark — send it to the reconnect page.
 *
 *   302 Location: <origin>/reconnect
 *       Cache-Control: no-store
 *
 * This is where Zoom drops a user whose grant lapsed: the root of WEB_ORIGIN,
 * the same host the install landing marks. A browser that approved the app
 * before skips the marketing homepage and reads why it is here.
 *
 * Only a bare / redirects. Any query string reaches the homepage: marketing
 * links carry ?utm_…, and the reconnect page's own "Go to the homepage" is
 * /?home, so a marked visitor can always get out, and stays out on a reload.
 * Every other path is left alone too.
 *
 * Null on the zoom.* host, which keeps serving the Zoom shell for every path,
 * and null without the mark: an unmarked visitor gets the homepage as before.
 *
 * The cached / revalidates on every visit (max-age=0, must-revalidate), so
 * this check runs before any cache answers. The redirect itself depends on the
 * request's cookie, so no cache may keep it.
 *
 * @param {Request} request
 * @param {URL} url
 * @returns {Response|null}
 */
export function reconnectRedirect(request, url) {
  const host = request.headers.get('host') || url.host;
  if (host.startsWith('zoom.')) return null;
  if (url.pathname !== '/' || url.search) return null;
  if (!approvedBefore(request)) return null;

  return new Response(null, {
    status: 302,
    headers: { Location: new URL('/reconnect', url.origin).toString(), 'Cache-Control': 'no-store' },
  });
}
