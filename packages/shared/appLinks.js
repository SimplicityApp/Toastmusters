/**
 * External links that more than one component needs.
 */

/**
 * The Zoom App Marketplace listing page, where the "Reviews" section lives.
 * Not the /zoomapp/<id>/context/... deeplink, which launches the app in a meeting.
 */
export const ZOOM_MARKETPLACE_REVIEW_URL =
  'https://marketplace.zoom.us/apps/sWHvcm4YShyr6SXQQI8DFw';

/**
 * The same listing as the place to learn about the app before adding it: the
 * small "See it on the Zoom Marketplace" link beside every "Add to Zoom", and
 * where /add-to-zoom falls back to when a deployment has no install link.
 */
export const ZOOM_MARKETPLACE_LISTING_URL = ZOOM_MARKETPLACE_REVIEW_URL;

/**
 * Canonical entry point of the web timer: the "Time this" deep-link target,
 * and the Zoom app's "use the browser timer" fallback. The Zoom app opens it
 * with zoomSdk.openUrl, which needs its domain on the Marketplace allow list
 * (toastmusters.com was added in the review submitted 2026-10).
 */
export const TIMER_APP_URL = 'https://www.toastmusters.com/timer/app';

/**
 * Every tool in the Toastmusters suite, each a path on www.toastmusters.com. Footers and nav
 * render from this list so a new tool is one entry here. URLs have no
 * trailing slash.
 */
export const TOOLS = [
  {
    slug: 'timer',
    name: 'Toastmusters Timer',
    url: 'https://www.toastmusters.com',
    tagline: 'Green, yellow and red timing signals for every speech, in the browser or as a Zoom app.',
  },
  {
    slug: 'table-topics',
    name: 'Table Topics Generator',
    url: 'https://www.toastmusters.com/tabletopics',
    tagline: 'Fresh Table Topics questions for every meeting, with a one-click timer.',
  },
];

/**
 * Zoom's OAuth authorize endpoint. One host worldwide: a user's region changes
 * nothing here, and this app is registered on the global Marketplace only (the
 * China platform, zoom.com.cn, is a separate service with its own apps). The
 * Worker builds every install link from this, and the Zoom app accepts a
 * stamped link only if it is on this origin — both from here, so they cannot
 * disagree.
 */
export const ZOOM_AUTHORIZE_URL = 'https://zoom.us/oauth/authorize';

/**
 * OAuth client id of the production Zoom app, and the redirect URI registered
 * against it in the Marketplace. The redirect URI must match the registered
 * value byte for byte, which is why it is still on the old host: the new
 * toastmusters.com redirect is added during the domain migration
 * (docs/DOMAIN_MIGRATION.md), not before.
 */
export const ZOOM_CLIENT_ID = 'DsFHK5sNQs2_VFyeQky2sg';
export const ZOOM_OAUTH_REDIRECT_URL = 'https://www.timer.simple-tech.app/oauth/redirect';

/**
 * Where a user goes to add — or re-add — the Zoom app. Zoom drops an app's
 * authorization on its own (app updates, admin changes, token expiry), and the
 * only cure is walking this flow again, so both the landing page's "Add to
 * Zoom" button and the in-app reconnect notice point here. One constant so the
 * two cannot drift apart.
 */
export const ZOOM_INSTALL_URL =
  `${ZOOM_AUTHORIZE_URL}?response_type=code` +
  `&client_id=${ZOOM_CLIENT_ID}` +
  `&redirect_uri=${encodeURIComponent(ZOOM_OAUTH_REDIRECT_URL)}`;

/**
 * The deeplink that opens the Zoom app inside the user's Zoom client. A Zoom
 * app's id is its OAuth client id, so the link is built from the `client_id`
 * of the install URL the same build uses. "Add to Zoom" and "Open Zoom app"
 * then always name the same app: a dev build (whose install link carries the
 * dev client id) opens the dev app, not the production one.
 *
 * @param {string} [installUrl] - A Zoom authorize URL. Anything without a
 *   `client_id` (unset, or the Marketplace listing fallback) means production.
 * @returns {string}
 */
export function zoomAppDeeplink(installUrl) {
  let appId = ZOOM_CLIENT_ID;
  try {
    appId = new URL(installUrl).searchParams.get('client_id') || ZOOM_CLIENT_ID;
  } catch {
    // Not a URL; keep the production id.
  }
  return `https://marketplace.zoom.us/zoomapp/${encodeURIComponent(appId)}/context/meeting/target/launch/deeplink`;
}

/** Support page section explaining why Zoom drops an app's access. */
export const ZOOM_RECONNECT_HELP_URL =
  'https://www.timer.simple-tech.app/support#lost-access';
