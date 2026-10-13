import { describe, it, expect } from 'vitest';
import { APPROVED_COOKIE, approvedBefore, installLandingRedirect } from './reconnect.js';

const ONE_YEAR_SEC = 365 * 24 * 60 * 60;

function landing(url, { cookie, host } = {}) {
  const parsed = new URL(url);
  const headers = { host: host ?? parsed.host };
  if (cookie) headers.cookie = cookie;
  return [new Request(url, { headers }), parsed];
}

const setCookies = (res) => res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie')].filter(Boolean);

describe('approvedBefore', () => {
  it('is true only when the request carries tt_approved=1', () => {
    const marked = (cookie) => approvedBefore(new Request('https://www.example.test/', cookie ? { headers: { cookie } } : {}));

    expect(APPROVED_COOKIE).toBe('tt_approved');
    expect(marked('tt_approved=1')).toBe(true);
    expect(marked('a=b; tt_approved=1; tt_session=x.y')).toBe(true);
    expect(marked(undefined)).toBe(false);
    expect(marked('tt_session=x.y')).toBe(false);
    expect(marked('tt_approved=0')).toBe(false);
    expect(marked('tt_approved=')).toBe(false);
    expect(marked('xtt_approved=1')).toBe(false);
  });
});

describe('installLandingRedirect', () => {
  it('sends a first install to ?welcome=new', () => {
    const res = installLandingRedirect(...landing('https://www.timer-dev.simple-tech.app/oauth/redirect?code=abc'));

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://www.timer-dev.simple-tech.app/oauth/redirect?welcome=new');
  });

  it('sends a browser that already carries the mark to ?welcome=back', () => {
    const res = installLandingRedirect(...landing('https://www.timer-dev.simple-tech.app/oauth/redirect?code=abc', { cookie: 'tt_approved=1' }));

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://www.timer-dev.simple-tech.app/oauth/redirect?welcome=back');
  });

  // Zoom's one-time code is a live credential: it must not survive into the
  // address bar, browser history or an analytics pageview. Nor does anything
  // else Zoom put on the URL.
  it('drops the code and every other query parameter', () => {
    const res = installLandingRedirect(...landing('https://www.timer.simple-tech.app/oauth/redirect?code=secret-code&foo=bar'));
    const location = new URL(res.headers.get('location'));

    expect(res.headers.get('location')).not.toContain('secret-code');
    expect([...location.searchParams.keys()]).toEqual(['welcome']);
  });

  it('marks the browser for a year, host-only and out of reach of page JavaScript', () => {
    for (const cookie of [undefined, 'tt_approved=1']) {
      const res = installLandingRedirect(...landing('https://www.timer.simple-tech.app/oauth/redirect?code=abc', { cookie }));
      const cookies = setCookies(res);

      expect(cookies).toEqual([
        `tt_approved=1; Path=/; Max-Age=${ONE_YEAR_SEC}; HttpOnly; Secure; SameSite=Lax`,
      ]);
      expect(cookies[0]).not.toMatch(/Domain=/i);
    }
  });

  // The answer depends on the request's cookie, so no cache may keep it.
  it('is never cached', () => {
    const res = installLandingRedirect(...landing('https://www.timer.simple-tech.app/oauth/redirect?code=abc'));

    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('stays on the host it was asked on', () => {
    const res = installLandingRedirect(...landing('http://localhost:8787/oauth/redirect?code=abc'));

    expect(res.headers.get('location')).toBe('http://localhost:8787/oauth/redirect?welcome=new');
  });

  // The zoom.<domain> host serves the Zoom shell for every path.
  it('leaves the zoom host alone', () => {
    for (const url of ['https://zoom.timer.simple-tech.app/oauth/redirect?code=abc', 'https://zoom.timer-dev.simple-tech.app/oauth/redirect?code=abc']) {
      expect(installLandingRedirect(...landing(url, { cookie: 'tt_approved=1' }))).toBeNull();
    }
  });
});
