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

import { isTableTopicsPath } from './tabletopics.js';

const OLD_WEB_HOST_PATTERN = /^(www\.)?timer(-dev)?\.simple-tech\.app$/;

// The public pages that move: every page in apps/web/public/sitemap.xml, matched
// without a trailing slash (the same way routeAssets in index.js matches
// ROOT_TO_ZOOM_REWRITES). The "moves every page the sitemap lists" test in
// routing.test.js fails when the sitemap gains a page that is not listed here.
// /tabletopics/* moves as well, as a prefix: see oldWebHostTarget.
const MOVED_PAGES = new Set([
  '/',
  // The guide and demo pages, apps/web/public/*.html
  '/toastmasters-timer-role-guide',
  '/toastmasters-speech-types-and-timing',
  '/toastmasters-timing-chart',
  '/toastmasters-timer-script',
  '/table-topics-timer',
  '/toastmasters-speech-contest-timing-rules',
  '/how-to-use-zoom-for-toastmasters',
  '/toastmasters-zoom-timer-backgrounds',
  '/best-toastmasters-timer-apps',
  '/toastmasters-timer-demo',
  '/toastmasters-timer-zoom-demo',
  // The Zoom listing's pages, served from the Zoom app's public dir via
  // ROOT_TO_ZOOM_REWRITES. The listing's Privacy, Terms and Support URLs point here.
  '/privacy',
  '/support',
  '/terms-of-use',
  '/documentation',
]);

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
 * A public page is one of MOVED_PAGES or anything under /tabletopics. A page
 * keeps its query, and lands without a trailing slash; Table Topics paths land
 * exactly as asked, because its trailing slash is part of the page's address.
 * Every other path, the app routes above all, stays: it returns null.
 *
 * @param {URL} url
 * @param {{ROOT_ORIGIN?: string}} env
 * @returns {string|null}
 */
export function oldWebHostTarget(url, env) {
  if (url.protocol !== 'https:' || !env.ROOT_ORIGIN || !OLD_WEB_HOST_PATTERN.test(url.hostname)) return null;
  const tableTopics = isTableTopicsPath(url.pathname);
  const path = url.pathname.replace(/\/$/, '') || '/';
  if (!tableTopics && !MOVED_PAGES.has(path)) return null;
  const target = new URL(tableTopics ? url.pathname : path, env.ROOT_ORIGIN);
  target.search = url.search;
  return target.toString();
}
