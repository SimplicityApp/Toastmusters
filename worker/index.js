import { handleZoomWebhook } from './zoom-webhook.js';
import { handleStats } from './stats.js';
import { handleZoomSession } from './session.js';
import { handleProfile } from './profile.js';
import { handleAsset } from './assets.js';

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

// Paths the root SPA (apps/web) owns via react-router. Anything else that
// misses the asset lookup is a genuine 404 — serving index.html with HTTP 200
// for unknown URLs creates soft 404s that waste crawl budget.
const SPA_ROUTES = new Set(['/', '/app', '/oauth/redirect']);

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
      return handleZoomSession(request, env);
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

    // 4. Redirect (was `redirects` in vercel.json): /web -> /app (302).
    //    Return early — Response.redirect() responses are immutable.
    if (pathname === '/web') {
      return Response.redirect(new URL('/app', url.origin).toString(), 302);
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
    return fetchAsset(env, url, '/zoom/index.html');
  }

  // --- Root clean URLs that map to /zoom/*.html (mirrors vercel.json) ---
  const rewrite = ROOT_TO_ZOOM_REWRITES[pathname.replace(/\/$/, '')];
  if (rewrite) {
    return fetchAsset(env, url, rewrite);
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
    return fetchAsset(env, url, '/zoom/index.html');
  }

  // The root SPA only owns the routes declared in App.jsx. Serve the shell for
  // those; everything else is a real 404 so crawlers stop treating unknown
  // URLs as valid pages.
  if (SPA_ROUTES.has(pathname.replace(/\/$/, '') || '/')) {
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
