// Table Topics generator Worker: serves the pre-rendered site in ./dist with a
// canonical-host redirect, a real 404, and security headers. Deliberately a
// trimmed copy of the timer Worker (../../../worker/index.js); when a third
// tool arrives, the shared parts move to packages/edge.

// All JS is external and hashed, so scripts need no 'unsafe-inline'. The
// stylesheet imports Google Fonts, hence the two font hosts. The
// toastmusters.com zone has Cloudflare Web Analytics on, which injects its
// beacon into HTML responses; allow it rather than have it blocked noisily.
const CSP = [
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

// The site is built under this path (see scripts/build.mjs) and served there
// on www.toastmusters.com, which reaches this Worker through the timer
// Worker's TABLETOPICS service binding.
const BASE_PATH = '/tabletopics';

// The subdomain the site used to live on. With ROOT_ORIGIN set, each of its
// URLs 301s to the same page under ROOT_ORIGIN/tabletopics, in one hop.
// Without it (the dev deployment, until a path-based dev host exists) the
// host keeps serving the site itself, under the same path. The https guard
// keeps `wrangler dev` (which rewrites Host to the first route) from bouncing
// localhost requests to production.
const LEGACY_HOST_PATTERN = /^(www\.)?tabletopics(-dev)?\.toastmusters\.com$/;

const onBasePath = (pathname) => pathname === BASE_PATH || pathname.startsWith(`${BASE_PATH}/`);

/** Where a path from before the move lives now: "/topics/x/" -> "/tabletopics/topics/x/". */
export function basePathFor(pathname) {
  return onBasePath(pathname) ? pathname : `${BASE_PATH}${pathname}`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.protocol === 'https:' && LEGACY_HOST_PATTERN.test(url.hostname)) {
      if (env.ROOT_ORIGIN) {
        const target = new URL(basePathFor(url.pathname), env.ROOT_ORIGIN);
        target.search = url.search;
        return Response.redirect(target.toString(), 301);
      }
      if (!url.hostname.startsWith('www.')) {
        url.hostname = `www.${url.hostname}`;
        return Response.redirect(url.toString(), 301);
      }
    }

    // A root-level URL from before the move, on a host that still serves the
    // site: send it under the base path.
    if (!onBasePath(url.pathname)) {
      url.pathname = basePathFor(url.pathname);
      return Response.redirect(url.toString(), 301);
    }

    let response = await env.ASSETS.fetch(request);
    if (response.status === 404) {
      const notFound = await env.ASSETS.fetch(new Request(new URL(`${BASE_PATH}/404.html`, url.origin), { method: 'GET' }));
      response = new Response(notFound.body, { status: 404, statusText: 'Not Found', headers: notFound.headers });
    }
    return withSecurityHeaders(response, url);
  },
};

export function withSecurityHeaders(response, url) {
  const headers = new Headers(response.headers);
  headers.set('Content-Security-Policy', CSP);
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
