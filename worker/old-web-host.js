// The timer's first web host, and its dev twin: (www.)timer(-dev).simple-tech.app.
//
// Its public pages also exist on the main site (ROOT_ORIGIN), and serving the
// same page on both hosts makes Google pick this one as canonical. So each public
// page here 301s to the same page on ROOT_ORIGIN (docs/TOASTMUSTERS_PATHS.md,
// step 2, public pages). The app routes stay: sign-in, Stripe and the Zoom install
// all come back to WEB_ORIGIN on this host, so moving them is a separate, later
// step (app routes and WEB_ORIGIN, still open).
//
// The helper lives in its own module, like the Table Topics legacy-host helpers
// in worker/tabletopics.js, because index.js (the redirect) and auth.js (the
// sign-in callback) both need it and index.js already imports auth.js.

const OLD_WEB_HOST_PATTERN = /^(www\.)?timer(-dev)?\.simple-tech\.app$/;

// Public pages that move, matched without a trailing slash. Phase 1 starts with
// the landing page; the rest of the sitemap and /tabletopics/* follow.
const MOVED_PAGES = new Set(['/']);

/**
 * The ROOT_ORIGIN URL for a public page on the old web host, or null if the
 * request stays where it is.
 *
 * Null unless the request is https (`wrangler dev` rewrites the Host header to
 * the first configured route, so over http every local request would look like
 * the old host), ROOT_ORIGIN is set (dev without it keeps serving), and the
 * hostname is an old web host. That excludes the zoom.<domain> hosts and
 * www.toastmusters.com itself.
 *
 * @param {URL} url
 * @param {{ROOT_ORIGIN?: string}} env
 * @returns {string|null}
 */
export function oldWebHostTarget(url, env) {
  if (url.protocol !== 'https:' || !env.ROOT_ORIGIN || !OLD_WEB_HOST_PATTERN.test(url.hostname)) return null;
  const path = url.pathname.replace(/\/$/, '') || '/';
  if (!MOVED_PAGES.has(path)) return null;
  const target = new URL(path, env.ROOT_ORIGIN);
  target.search = url.search;
  return target.toString();
}
