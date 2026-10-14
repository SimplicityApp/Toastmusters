import { describe, it, expect } from 'vitest';
import { oldWebHostTarget } from './old-web-host.js';

const PROD = { ROOT_ORIGIN: 'https://www.toastmusters.com' };
const DEV = { ROOT_ORIGIN: 'https://www.timer-dev.toastmusters.com' };
const target = (url, env) => oldWebHostTarget(new URL(url), env);

describe('oldWebHostTarget', () => {
  it.each([
    [PROD, 'https://timer.simple-tech.app/', 'https://www.toastmusters.com/'],
    [PROD, 'https://www.timer.simple-tech.app/', 'https://www.toastmusters.com/'],
    [DEV, 'https://timer-dev.simple-tech.app/', 'https://www.timer-dev.toastmusters.com/'],
    [DEV, 'https://www.timer-dev.simple-tech.app/', 'https://www.timer-dev.toastmusters.com/'],
  ])('sends the homepage on each old host to ROOT_ORIGIN (%#)', (env, from, to) => {
    expect(target(from, env)).toBe(to);
  });

  it('keeps the query', () => {
    expect(target('https://www.timer.simple-tech.app/?utm_source=x&ref=y', PROD)).toBe(
      'https://www.toastmusters.com/?utm_source=x&ref=y'
    );
  });

  it('takes the ROOT_ORIGIN host from env, whichever old host asked', () => {
    expect(target('https://www.timer.simple-tech.app/', DEV)).toBe('https://www.timer-dev.toastmusters.com/');
  });

  // zoom.<domain> is the Zoom app's home and www.toastmusters.com is the target
  // itself; neither may ever be sent anywhere by this rule.
  it.each([
    'https://zoom.timer.simple-tech.app/',
    'https://zoom.timer-dev.simple-tech.app/',
    'https://www.toastmusters.com/',
    'https://www.timer.toastmusters.com/',
    'https://toastmaster-timer.workers.dev/',
  ])('leaves %s alone', (url) => {
    expect(target(url, PROD)).toBeNull();
  });

  it('leaves look-alike hosts alone', () => {
    expect(target('https://evil-timer.simple-tech.app/', PROD)).toBeNull();
    expect(target('https://www.timer.simple-tech.app.evil.test/', PROD)).toBeNull();
    expect(target('https://sub.www.timer.simple-tech.app/', PROD)).toBeNull();
  });

  // `wrangler dev` rewrites the Host header to the first configured route, so
  // over http every local request looks like the old host.
  it('does nothing over http', () => {
    expect(target('http://www.timer.simple-tech.app/', PROD)).toBeNull();
    expect(target('http://localhost:8787/', PROD)).toBeNull();
  });

  it('does nothing without ROOT_ORIGIN', () => {
    expect(target('https://www.timer.simple-tech.app/', {})).toBeNull();
    expect(target('https://www.timer.simple-tech.app/', { ROOT_ORIGIN: '' })).toBeNull();
  });

  // The app stays on this host: sign-in, Stripe and the Zoom install all come
  // back to WEB_ORIGIN.
  it.each(['/timer/app', '/oauth/redirect', '/account', '/api/stats', '/zoom/', '/add-to-zoom'])(
    'keeps the app path %s on the old host',
    (path) => {
      expect(target(`https://www.timer.simple-tech.app${path}`, PROD)).toBeNull();
    }
  );
});
