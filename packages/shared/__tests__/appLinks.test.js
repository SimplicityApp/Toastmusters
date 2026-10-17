import {
  TOOLS,
  TIMER_APP_URL,
  ZOOM_MARKETPLACE_REVIEW_URL,
  ZOOM_CLIENT_ID,
  ZOOM_INSTALL_URL,
  ZOOM_OAUTH_REDIRECT_URL,
  ZOOM_RECONNECT_HELP_URL,
  zoomAppDeeplink,
} from '../appLinks.js';

describe('TOOLS registry', () => {
  it('lists at least the timer and the Table Topics generator', () => {
    const slugs = TOOLS.map((tool) => tool.slug);
    expect(slugs).toContain('timer');
    expect(slugs).toContain('table-topics');
  });

  it('has a unique slug per tool', () => {
    const slugs = TOOLS.map((tool) => tool.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('gives every tool a name, a tagline and an https URL without a trailing slash', () => {
    for (const tool of TOOLS) {
      expect(tool.name, tool.slug).toBeTruthy();
      expect(tool.tagline, tool.slug).toBeTruthy();
      expect(tool.url, tool.slug).toMatch(/^https:\/\//);
      expect(tool.url, tool.slug).not.toMatch(/\/$/);
    }
  });
});

describe('TIMER_APP_URL', () => {
  it('lives under the timer tool URL', () => {
    const timer = TOOLS.find((tool) => tool.slug === 'timer');
    expect(TIMER_APP_URL.startsWith(`${timer.url}/`)).toBe(true);
  });
});

describe('ZOOM_MARKETPLACE_REVIEW_URL', () => {
  it('is still exported', () => {
    expect(ZOOM_MARKETPLACE_REVIEW_URL).toMatch(/^https:\/\/marketplace\.zoom\.us\//);
  });
});

describe('ZOOM_INSTALL_URL', () => {
  it('is a Zoom authorization URL carrying the production client id', () => {
    const url = new URL(ZOOM_INSTALL_URL);

    expect(url.origin + url.pathname).toBe('https://zoom.us/oauth/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe(ZOOM_CLIENT_ID);
  });

  // Zoom matches the redirect URI against the registered value, so a typo here
  // fails the install with a Zoom error page and no way back.
  it('redirects to the registered callback, which the web app owns', () => {
    expect(new URL(ZOOM_INSTALL_URL).searchParams.get('redirect_uri')).toBe(ZOOM_OAUTH_REDIRECT_URL);
    expect(ZOOM_OAUTH_REDIRECT_URL).toMatch(/^https:\/\/[^/]+\/oauth\/redirect$/);
  });
});

describe('zoomAppDeeplink', () => {
  const DEV_INSTALL_URL =
    'https://zoom.us/oauth/authorize?response_type=code&client_id=kgpoX2A6TY2BvdctzK9iw' +
    '&redirect_uri=https://www.timer-dev.simple-tech.app/oauth/redirect';

  it('opens the production app from the production install URL', () => {
    expect(zoomAppDeeplink(ZOOM_INSTALL_URL)).toBe(
      `https://marketplace.zoom.us/zoomapp/${ZOOM_CLIENT_ID}/context/meeting/target/launch/deeplink`,
    );
  });

  // The dev build's "Open Zoom app" must name the same app its "Add to Zoom"
  // just authorized, or a dev tester lands in the production app.
  it('opens the app whose client id the install URL carries', () => {
    expect(zoomAppDeeplink(DEV_INSTALL_URL)).toBe(
      'https://marketplace.zoom.us/zoomapp/kgpoX2A6TY2BvdctzK9iw/context/meeting/target/launch/deeplink',
    );
  });

  it.each([undefined, '', 'not a url', 'https://marketplace.zoom.us/apps/sWHvcm4YShyr6SXQQI8DFw'])(
    'falls back to the production app for %j',
    (installUrl) => {
      expect(zoomAppDeeplink(installUrl)).toContain(`/zoomapp/${ZOOM_CLIENT_ID}/`);
    },
  );
});

describe('ZOOM_RECONNECT_HELP_URL', () => {
  it('points at the support page section that explains a dropped install', () => {
    expect(ZOOM_RECONNECT_HELP_URL).toMatch(/\/support#lost-access$/);
  });
});
