// Table Topics, served by this Worker under /tabletopics.
//
// The site is pre-rendered by apps/table-topics (scripts/build.mjs) with
// every page, asset and link under /tabletopics, and copied into dist/ next
// to the timer site, so the same ASSETS binding serves both. What the timer
// Worker's own routing would get wrong for it is kept here: its 404 page (the
// SPA fallback would answer 200), its Content-Security-Policy (the timer's
// allows inline scripts; this one does not), and its cache headers.

const BASE_PATH = '/tabletopics';

// The subdomain the site used to live on, and its dev twin. With ROOT_ORIGIN
// set, each of its URLs 301s to the same page under ROOT_ORIGIN/tabletopics.
const LEGACY_HOST_PATTERN = /^(www\.)?tabletopics(-dev)?\.toastmusters\.com$/;

// All JS is external and hashed, so scripts need no 'unsafe-inline'. The
// stylesheet imports Google Fonts, hence the two font hosts. The
// toastmusters.com zone has Cloudflare Web Analytics on, which injects its
// beacon into HTML responses; allow it rather than have it blocked noisily.
export const TABLETOPICS_CSP = [
  "default-src 'self'",
  "script-src 'self' https://e.simple-tech.app https://us-assets.i.posthog.com https://static.cloudflareinsights.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: https:",
  "connect-src 'self' https://e.simple-tech.app https://us.i.posthog.com https://*.posthog.com https://cloudflareinsights.com",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

/** Is this path part of the Table Topics site? */
export const isTableTopicsPath = (pathname) => pathname === BASE_PATH || pathname.startsWith(`${BASE_PATH}/`);

/** Where a path from before the move lives now: "/topics/x/" -> "/tabletopics/topics/x/". */
export function basePathFor(pathname) {
  return isTableTopicsPath(pathname) ? pathname : `${BASE_PATH}${pathname}`;
}

export const isLegacyTableTopicsHost = (hostname) => LEGACY_HOST_PATTERN.test(hostname);

/** The main-site URL for a request to the old tabletopics.toastmusters.com host. */
export function legacyTableTopicsTarget(url, rootOrigin) {
  const target = new URL(basePathFor(url.pathname), rootOrigin);
  target.search = url.search;
  return target.toString();
}

/** Serve a /tabletopics request from the assets, with its own 404 and headers. */
export async function serveTableTopics(request, env, url) {
  let response = await env.ASSETS.fetch(request);
  if (response.status === 404) {
    const notFound = await env.ASSETS.fetch(new Request(new URL(`${BASE_PATH}/404.html`, url.origin), { method: 'GET' }));
    response = new Response(notFound.body, { status: 404, statusText: 'Not Found', headers: notFound.headers });
  }
  return withTableTopicsHeaders(response, url);
}

export function withTableTopicsHeaders(response, url) {
  const headers = new Headers(response.headers);
  headers.set('Content-Security-Policy', TABLETOPICS_CSP);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubdomains');

  // The dev host mirrors production content with production canonicals; keep
  // it out of the index regardless.
  if (url.hostname.includes('-dev.')) {
    headers.set('X-Robots-Tag', 'noindex, nofollow');
  }

  if (url.pathname.startsWith(`${BASE_PATH}/assets/`)) {
    // Content-hashed by the build.
    headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  } else if (url.pathname === `${BASE_PATH}/questions.json`) {
    headers.set('Cache-Control', 'public, max-age=3600');
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
