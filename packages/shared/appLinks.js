/**
 * External links that more than one component needs.
 */

/**
 * The Zoom App Marketplace listing page, where the "Reviews" section lives.
 * Not the /zoomapp/<id>/context/... deeplink, which launches the app in a meeting.
 */
export const ZOOM_MARKETPLACE_REVIEW_URL =
  'https://marketplace.zoom.us/apps/sWHvcm4YShyr6SXQQI8DFw';

/** Canonical entry point of the web timer (the "Time this" deep-link target). */
export const TIMER_APP_URL = 'https://www.timer.toastmusters.com/app';

/**
 * Every tool in the Toastmusters suite, one subdomain each. Footers and nav
 * render from this list so a new tool is one entry here. URLs have no
 * trailing slash.
 */
export const TOOLS = [
  {
    slug: 'timer',
    name: 'Toastmusters Timer',
    url: 'https://www.timer.toastmusters.com',
    tagline: 'Green, yellow and red timing signals for every speech, in the browser or as a Zoom app.',
  },
  {
    slug: 'table-topics',
    name: 'Table Topics Generator',
    url: 'https://www.tabletopics.toastmusters.com',
    tagline: 'Fresh Table Topics questions for every meeting, with a one-click timer.',
  },
];

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
  'https://zoom.us/oauth/authorize?response_type=code' +
  `&client_id=${ZOOM_CLIENT_ID}` +
  `&redirect_uri=${encodeURIComponent(ZOOM_OAUTH_REDIRECT_URL)}`;

/** Support page section explaining why Zoom drops an app's access. */
export const ZOOM_RECONNECT_HELP_URL =
  'https://www.timer.simple-tech.app/support#lost-access';
