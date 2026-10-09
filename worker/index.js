import { handleZoomWebhook } from './zoom-webhook.js';
import { handleStats } from './stats.js';
import { handleZoomSession } from './session.js';
import { handleZoomContact, captureInstallContact } from './contact.js';
import { handleProfile } from './profile.js';
import { handleAsset } from './assets.js';
import { handleMe } from './me.js';
import { handleAuthStart, handleOAuthCallback, handleLogout, zoomAuthorizeUrl } from './auth.js';
import { ZOOM_MARKETPLACE_LISTING_URL } from '../packages/shared/appLinks.js';
import { isLegacyTableTopicsHost, isTableTopicsPath, legacyTableTopicsTarget, serveTableTopics } from './tabletopics.js';
import { handleBilling } from './billing.js';
import { handleClub } from './club.js';
import { handleClubAsset } from './club-assets.js';
import { handleSharedReport } from './club-share.js';
import { handleStripeWebhook } from './stripe-webhook.js';

// Content-Security-Policy for the marketing + web app (root). Mirrors the
// "/(.*)" rule from the old vercel.json.
const ROOT_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://e.simple-tech.app https://*.posthog.com https://us-assets.i.posthog.com https://www.youtube.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: blob: https:; font-src 'self' data: https://fonts.gstatic.com; connect-src 'self' https://e.simple-tech.app https://*.posthog.com https://us.i.posthog.com https://us-assets.i.posthog.com; frame-src 'self' https://www.youtube.com; frame-ancestors 'self'; base-uri 'self'; form-action 'self'";

// CSP for the Zoom app. Mirrors the "/zoom/(.*)" rule from vercel.json
// (allows the Zoom Apps SDK + zoom.us frames/connections).
const ZOOM_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://e.simple-tech.app https://appssdk.zoom.us https://*.posthog.com https://us-assets.i.posthog.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https://e.simple-tech.app https://appssdk.zoom.us https://*.zoom.us https://*.posthog.com https://us.i.posthog.com https://us-assets.i.posthog.com; frame-src 'self' https://*.zoom.us;";

// Clean URLs served at the root that map to files living under /zoom/.
// html_handling can't cross directories (it only appends ".html" at the same
// path), so these mirror the explicit rewrites from vercel.json.
const ROOT_TO_ZOOM_REWRITES = {
  '/privacy': '/zoom/privacy.html',
  '/support': '/zoom/support.html',
  '/terms-of-use': '/zoom/terms-of-use.html',
  '/documentation': '/zoom/documentation.html',
};

// Apex hosts that must 301 to their www counterpart. Serving identical content
// on two hosts splits link equity and leaves the canonical tag as the only
// signal to search engines; a redirect makes www the single indexable origin.
// The timer host under both the old and the new domain (docs/DOMAIN_MIGRATION.md)
// canonicalizes to its *own* www host; the cross-domain redirect comes in a
// later phase. The bare toastmusters.com root is parked here for now too.
const APEX_HOST_PATTERN = /^(timer(-dev)?\.(simple-tech\.app|toastmusters\.com)|toastmusters\.com)$/;

// The toastmusters.com subdomain the timer used to live on. With ROOT_ORIGIN
// set, each of its URLs 301s to the same page on the main site in one hop
// (the web timer's old /app becomes /timer/app). zoom.timer.toastmusters.com
// is not on this list: it may become the Zoom app's home when the Zoom app
// moves, and a cached 301 would get in the way. Nor is timer.simple-tech.app,
// which keeps serving until its own redirect step (#81).
const LEGACY_TIMER_HOST_PATTERN = /^(www\.)?timer\.toastmusters\.com$/;

/** The main-site URL for a request to the old timer.toastmusters.com host. */
export function legacyTimerTarget(url, rootOrigin) {
  let { pathname, search } = url;
  if (pathname === '/app' || pathname === '/app/') {
    pathname = '/timer/app';
  } else if (pathname === '/web') {
    pathname = '/timer/app';
    search = '';
  }
  const target = new URL(pathname, rootOrigin);
  target.search = search;
  return target.toString();
}

// Paths the root SPA (apps/web) owns via react-router. Anything else that
// misses the asset lookup is a genuine 404 — serving index.html with HTTP 200
// for unknown URLs creates soft 404s that waste crawl budget.
const SPA_ROUTES = new Set([
  '/',
  '/timer/app',
  '/oauth/redirect',
  '/billing/success',
  '/billing/cancel',
  '/account',
  // The officer's console and the page that spends a mailed admin link. Both
  // are browser-only: an officer reviewing their roster is not in a meeting,
  // and a magic link cannot open inside the Zoom sidebar.
  '/club/admin',
  '/club/manage',
]);

// Root SPA routes whose tail is data rather than a page: /pro/<code> is the
// officer's shareable activation link, so the set of valid paths is the set of
// club codes and cannot be enumerated here.
const SPA_ROUTE_PREFIXES = ['/pro/'];

/**
 * Zoom sends `x-zoom-app-context` on the document request when it opens an app
 * inside the client; an ordinary browser never does. That header is the only
 * thing separating "the Zoom client opened us" from "someone has this URL in a
 * tab", and the app needs the distinction: a config() failure means *lost
 * authorization* in the first case and *not in Zoom at all* in the second.
 * Exported for testing.
 */
export function zoomLaunchContext(request) {
  return request.headers.get('x-zoom-app-context') ? 'client' : 'browser';
}

// The stamped install link lands inside an attribute: the `&` between its
// query parameters, or a quote, must not end the attribute early.
const escapeAttribute = (value) =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// Paths that resolve to the Zoom SPA shell by name rather than by falling
// through. They need naming because the asset store answers them directly —
// html_handling turns "/zoom/" into "/zoom/index.html" before the SPA fallback
// below is ever reached, which would serve the shell without a launch marker.
const ZOOM_SHELL_PATHS = new Set(['/zoom', '/zoom/index.html']);

// robots.txt for the zoom.<domain> host. The Zoom app is noindex, so the whole
// subdomain is disallowed rather than falling through to the SPA shell (which
// would return HTML for /robots.txt).
const ZOOM_ROBOTS_TXT = 'User-agent: *\nDisallow: /\n';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    const host = request.headers.get('host') || '';

    // 1. Dynamic API route: Zoom webhook (was api/zoom/webhook.js on Vercel).
    //    Runs before the www redirect so Zoom's webhook POSTs are never
    //    redirected (a 301 would drop the request body).
    if (pathname === '/api/zoom/webhook') {
      return handleZoomWebhook(request, env, ctx);
    }

    // Usage stats for the landing page (edge-cached PostHog query).
    if (pathname === '/api/stats') {
      return handleStats(request, env, ctx);
    }

    // Zoom identity. Runs before the www redirect for the same reason the
    // webhook does: a 301 would drop the POST body carrying the app context.
    // It also has to stay ahead of host routing so the zoom.<domain> host can
    // reach it without being rewritten into /zoom/*.
    if (pathname === '/api/zoom/session') {
      return handleZoomSession(request, env, ctx);
    }

    // The Zoom app's in-client authorization code, spent to save the user's
    // Zoom email and name. Placed with the identity endpoint for the same
    // reasons: a POST body, and reachable from the zoom.<domain> host.
    if (pathname === '/api/zoom/contact') {
      return handleZoomContact(request, env);
    }

    // Cross-device settings. Ahead of the redirect for the same body-dropping
    // reason as above, and ahead of host routing so the Zoom app can reach it.
    if (pathname === '/api/profile') {
      return handleProfile(request, env);
    }

    // Custom card artwork. Same placement rationale as the two above.
    if (pathname.startsWith('/api/assets/')) {
      return handleAsset(request, url, env);
    }

    // The club's logo, served to anyone. Ahead of host routing so the Zoom app
    // can reach it from the zoom.<domain> host, and ahead of the www redirect
    // so the badge compositor is never asked to follow a 301 mid-frame. This is
    // the one asset route with no session at all: its readers are a guest's
    // compositor and a crawler fetching a shared report's preview.
    if (pathname.startsWith('/api/club-assets/')) {
      return handleClubAsset(request, url, env);
    }

    // Club activation and the daily club refresh. Ahead of the www redirect
    // like every other POST, and ahead of host routing so the Zoom app can
    // reach it from the zoom.<domain> host. The doors into a club (activate,
    // create, the admin link) sit behind the pro flag; the refresh never does.
    if (pathname === '/api/club' || pathname.startsWith('/api/club/')) {
      return handleClub(request, url, env, { ctx });
    }

    // Identity + entitlement re-check (polled after a purchase). The web app's
    // identity call adds ?flags=1 for the release flags; the polls do not.
    if (pathname === '/api/me') {
      return handleMe(request, env, ctx);
    }

    // Stripe Checkout / Billing Portal. Ahead of the redirect like every POST.
    if (pathname.startsWith('/api/billing/')) {
      return handleBilling(request, url, env, { ctx });
    }

    // Stripe webhook: a 301 would drop the signed body, exactly like Zoom's.
    if (pathname === '/api/stripe/webhook') {
      return handleStripeWebhook(request, env);
    }

    // Sign in with Zoom (web). The callback shares /oauth/redirect with the
    // Marketplace install flow: only a request carrying a state we signed is a
    // sign-in; everything else falls through to the SPA's install-success page.
    // Both sit behind the pro flag; logout never does.
    if (pathname === '/api/auth/zoom/start') {
      return handleAuthStart(request, url, env, { ctx });
    }
    if (pathname === '/api/auth/logout') {
      return handleLogout(request);
    }
    if (pathname === '/oauth/redirect' && url.searchParams.has('state')) {
      const signedIn = await handleOAuthCallback(request, url, env, { ctx });
      if (signedIn) return signedIn;
    }
    // A Marketplace install or re-add: no state of ours, just Zoom's code. The
    // page below renders unchanged; the code is spent in the background only
    // to learn the user's contact details (worker/contact.js). No session is
    // minted from it, and it is not flagged. Ahead of every redirect, so the
    // origin it sends back to Zoom is the one the code was issued for.
    if (pathname === '/oauth/redirect' && url.searchParams.has('code') && !url.searchParams.has('state')) {
      ctx.waitUntil(
        captureInstallContact(env, url).catch((error) =>
          console.error('Install contact capture error:', error?.message || error))
      );
    }

    // 2a. The old toastmusters.com timer hosts move to the main site. After
    //     every API route above (a 301 would drop a POST body) and before the
    //     apex rule below, so timer.toastmusters.com takes one hop, not two.
    //     https only, for the same wrangler dev reason as the apex rule.
    if (url.protocol === 'https:' && env.ROOT_ORIGIN && LEGACY_TIMER_HOST_PATTERN.test(url.hostname)) {
      return Response.redirect(legacyTimerTarget(url, env.ROOT_ORIGIN), 301);
    }

    // 2b. The old tabletopics.toastmusters.com hosts (and the dev twin) move to
    //     /tabletopics on the main site, same rule and same reason as above.
    if (url.protocol === 'https:' && env.ROOT_ORIGIN && isLegacyTableTopicsHost(url.hostname)) {
      return Response.redirect(legacyTableTopicsTarget(url, env.ROOT_ORIGIN), 301);
    }

    // 2. Canonical host: apex -> www (301). The zoom.<domain> host is a
    //    separate app and is left alone.
    //
    //    The https check is what keeps local development working. `wrangler
    //    dev` rewrites BOTH the request URL and the Host header to the first
    //    configured route (timer.simple-tech.app), so a host-only check would
    //    bounce every localhost request to production. Local dev is served
    //    over http; deployed traffic is always https (see HSTS below).
    if (url.protocol === 'https:' && APEX_HOST_PATTERN.test(url.hostname)) {
      url.hostname = `www.${url.hostname}`;
      return Response.redirect(url.toString(), 301);
    }

    // 3. robots.txt on the zoom.<domain> host. Without this the host-based
    //    routing below would answer with the Zoom SPA shell (HTML).
    if (pathname === '/robots.txt' && host.startsWith('zoom.')) {
      return new Response(ZOOM_ROBOTS_TXT, {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }

    // 3a. Table Topics lives at /tabletopics, in this Worker's own assets (the
    //     build copies apps/table-topics/dist into dist/). It has its own 404
    //     page, CSP and cache headers, so it never reaches the timer's SPA
    //     fallback or security headers below. Not on the zoom.<domain> host,
    //     which is the Zoom app.
    if (!host.startsWith('zoom.') && isTableTopicsPath(pathname)) {
      return serveTableTopics(request, env, url);
    }

    // 3b. A shared meeting report. Worker-rendered HTML rather than an SPA
    //     route, because a link-preview crawler does not run JavaScript: the
    //     OG tags have to be in the bytes this returns. Placed after the apex
    //     redirect so a pasted link canonicalizes to www first, and before the
    //     asset lookup so /r/<token> never falls through to the shell.
    if (pathname.startsWith('/r/')) {
      return withSecurityHeaders(await handleSharedReport(request, url, env), request, url);
    }

    // 4. The web timer lives at /timer/app. /app (its old path) moves
    //    permanently, keeping the query so a Table Topics deep link still opens
    //    its question; /web, an older alias, goes straight there in one hop.
    //    /timer itself is held for a timer landing page should / ever become a
    //    suite home, so for now it points at the landing page with a 302,
    //    which browsers do not cache. Return early — Response.redirect()
    //    responses are immutable.
    if (pathname === '/app' || pathname === '/app/' || pathname === '/web') {
      const target = new URL(`/timer/app${pathname === '/web' ? '' : url.search}`, url.origin);
      return Response.redirect(target.toString(), pathname === '/web' ? 302 : 301);
    }
    if (pathname === '/timer' || pathname === '/timer/') {
      return Response.redirect(new URL('/', url.origin).toString(), 302);
    }

    // 4b. "Add to Zoom" from the static pages, which cannot know which Zoom app
    //     this deployment installs. Straight to Zoom's install screen for the
    //     deployment's app; to the Marketplace listing when it has no install
    //     link configured. Not a page: noindex, never cached.
    if (pathname === '/add-to-zoom') {
      const target = zoomAuthorizeUrl(env)?.toString() ?? ZOOM_MARKETPLACE_LISTING_URL;
      return new Response(null, {
        status: 302,
        headers: { Location: target, 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
      });
    }

    // 5. Serve the right asset (host-based routing + SPA fallback), then
    //    attach security headers.
    const response = await routeAssets(request, env, url);
    return withSecurityHeaders(response, request, url);
  },
};

/**
 * Resolve a request to a static asset response.
 *
 * Handles:
 *  - host-based routing: zoom.<domain> serves the Zoom app (was middleware.js)
 *  - direct asset hits (incl. clean URLs via html_handling)
 *  - SPA fallback for two independent SPAs (web at /, zoom under /zoom)
 */
async function routeAssets(request, env, url) {
  const { pathname } = url;
  const host = request.headers.get('host') || '';

  // --- Host-based routing: zoom.<domain> -> /zoom/* (mirrors middleware.js) ---
  if (host.startsWith('zoom.') && !pathname.startsWith('/zoom/')) {
    if (pathname.startsWith('/assets/') || pathname.startsWith('/backgrounds/')) {
      return fetchAsset(env, url, '/zoom' + pathname);
    }
    // Root and any other path -> the Zoom app SPA shell.
    return fetchZoomShell(env, url, request);
  }

  // --- Root clean URLs that map to /zoom/*.html (mirrors vercel.json) ---
  const rewrite = ROOT_TO_ZOOM_REWRITES[pathname.replace(/\/$/, '')];
  if (rewrite) {
    return fetchAsset(env, url, rewrite);
  }

  // --- The Zoom shell reached by path, before the asset store answers it ---
  if (ZOOM_SHELL_PATHS.has(pathname.replace(/\/$/, '') || '/')) {
    return fetchZoomShell(env, url, request);
  }

  // --- Direct asset (also resolves clean URLs like /privacy -> /privacy.html) ---
  const assetResponse = await env.ASSETS.fetch(request);
  if (assetResponse.status !== 404) {
    return assetResponse;
  }

  // --- SPA fallback: two separate apps share this Worker ---
  // The Zoom app is noindex and Zoom deep-links into it, so its fallback stays
  // permissive.
  if (pathname.startsWith('/zoom')) {
    return fetchZoomShell(env, url, request);
  }

  // The root SPA only owns the routes declared in App.jsx. Serve the shell for
  // those; everything else is a real 404 so crawlers stop treating unknown
  // URLs as valid pages.
  const spaPath = pathname.replace(/\/$/, '') || '/';
  if (SPA_ROUTES.has(spaPath) || SPA_ROUTE_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return fetchAsset(env, url, '/index.html');
  }

  const notFound = await fetchAsset(env, url, '/404.html');
  return new Response(notFound.body, {
    status: 404,
    statusText: 'Not Found',
    headers: notFound.headers,
  });
}

/** Fetch a specific asset path from the ASSETS binding. */
function fetchAsset(env, url, assetPath) {
  return env.ASSETS.fetch(new Request(new URL(assetPath, url.origin), { method: 'GET' }));
}

/**
 * Serve the Zoom SPA shell with the launch context stamped into its <head>, so
 * the app knows on first paint whether it is running inside the Zoom client —
 * and, when the Worker is configured for OAuth, the "add the app" link for the
 * Zoom app this deployment belongs to. The bundle's build-time link names one
 * app for every deployment, which is how the dev host sent its guests through
 * the production install.
 *
 * The marker is per-request, so the shell must not be cached: a stored
 * `content="client"` served to a browser would hide the reconnect notice, and a
 * stored `content="browser"` served in-client would show it to a working user.
 * The shell is ~1KB and only references hashed assets, so no-store costs
 * nothing worth keeping.
 */
async function fetchZoomShell(env, url, request) {
  const response = await fetchAsset(env, url, '/zoom/index.html');
  if (!response.ok) return response;

  const html = await response.text();
  const installUrl = zoomAuthorizeUrl(env);
  const marker =
    `<meta name="zoom-launch" content="${zoomLaunchContext(request)}">` +
    (installUrl ? `<meta name="zoom-install-url" content="${escapeAttribute(installUrl.toString())}">` : '');
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store');
  // Both describe the asset as stored, and the injected marker has just made
  // them wrong: a stale content-length can truncate the body, and a stale etag
  // could hand a revalidating client a 304 for a shell it never received.
  headers.delete('content-length');
  headers.delete('etag');

  return new Response(html.replace('<head>', `<head>${marker}`), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Attach security headers (was the `headers` block in vercel.json).
 *
 * CSP is chosen by whether we're serving Zoom content — either the zoom
 * subdomain or a /zoom path — so the Zoom app always gets the SDK-friendly CSP,
 * even when served at the subdomain root.
 */
function withSecurityHeaders(response, request, url) {
  const host = request.headers.get('host') || '';
  const isZoom = host.startsWith('zoom.') || url.pathname.startsWith('/zoom');

  const headers = new Headers(response.headers);
  headers.set('Content-Security-Policy', isZoom ? ZOOM_CSP : ROOT_CSP);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubdomains');

  // The OAuth callback is a machine endpoint, not a page. robots.txt disallows
  // crawling it; this also keeps the URL itself out of the index.
  if (url.pathname.startsWith('/oauth/')) {
    headers.set('X-Robots-Tag', 'noindex, nofollow');
  }

  // Deep links like /timer/app?role=…&name=… (one per Table Topics question)
  // are app state, not pages. Keep them out of the index; bare /timer/app is
  // unaffected.
  if (url.pathname === '/timer/app' && url.search) {
    headers.set('X-Robots-Tag', 'noindex');
  }

  // Immutable caching for background images (was /zoom/backgrounds/(.*)).
  const isBackground =
    url.pathname.startsWith('/zoom/backgrounds/') ||
    (host.startsWith('zoom.') && url.pathname.startsWith('/backgrounds/'));
  if (isBackground) {
    headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
