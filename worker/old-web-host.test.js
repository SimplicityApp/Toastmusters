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
    expect(target('https://www.timer.simple-tech.app/privacy?lang=fr', PROD)).toBe(
      'https://www.toastmusters.com/privacy?lang=fr'
    );
    expect(target('https://www.timer.simple-tech.app/tabletopics/today/?q=1', PROD)).toBe(
      'https://www.toastmusters.com/tabletopics/today/?q=1'
    );
  });

  // The guides, the video pages and the Zoom listing's legal pages all move.
  it.each([
    ['/toastmasters-timer-role-guide', '/toastmasters-timer-role-guide'],
    ['/toastmasters-timing-chart', '/toastmasters-timing-chart'],
    ['/best-toastmasters-timer-apps', '/best-toastmasters-timer-apps'],
    ['/toastmasters-timer-zoom-demo', '/toastmasters-timer-zoom-demo'],
    ['/privacy', '/privacy'],
    ['/support', '/support'],
    ['/terms-of-use', '/terms-of-use'],
    ['/documentation', '/documentation'],
  ])('moves the public page %s to the same path on ROOT_ORIGIN', (path, expected) => {
    expect(target(`https://www.timer.simple-tech.app${path}`, PROD)).toBe(`https://www.toastmusters.com${expected}`);
    expect(target(`https://www.timer-dev.simple-tech.app${path}`, DEV)).toBe(`https://www.timer-dev.toastmusters.com${expected}`);
  });

  // A page is matched, and lands, without its trailing slash.
  it('drops the trailing slash of a page', () => {
    expect(target('https://www.timer.simple-tech.app/best-toastmasters-timer-apps/', PROD)).toBe(
      'https://www.toastmusters.com/best-toastmasters-timer-apps'
    );
    expect(target('https://www.timer.simple-tech.app/privacy/?x=1', PROD)).toBe('https://www.toastmusters.com/privacy?x=1');
  });

  // Everything under /tabletopics moves, and keeps its path exactly: that site
  // is pre-rendered with trailing slashes, so the slash is part of the address.
  it.each([
    ['/tabletopics', '/tabletopics'],
    ['/tabletopics/', '/tabletopics/'],
    ['/tabletopics/topics/', '/tabletopics/topics/'],
    ['/tabletopics/topics', '/tabletopics/topics'],
    ['/tabletopics/assets/index-abc123.js', '/tabletopics/assets/index-abc123.js'],
    ['/tabletopics/sitemap.xml', '/tabletopics/sitemap.xml'],
  ])('moves the Table Topics path %s as it is', (path, expected) => {
    expect(target(`https://www.timer.simple-tech.app${path}`, PROD)).toBe(`https://www.toastmusters.com${expected}`);
    expect(target(`https://timer-dev.simple-tech.app${path}`, DEV)).toBe(`https://www.timer-dev.toastmusters.com${expected}`);
  });

  // Only /tabletopics itself and what is under it; not any path that starts with
  // the same letters.
  it.each(['/tabletopics-old', '/tabletopicsx/', '/table-topics', '/tabletopic/'])(
    'leaves the look-alike path %s alone',
    (path) => {
      expect(target(`https://www.timer.simple-tech.app${path}`, PROD)).toBeNull();
    }
  );

  // The prefix rule sits behind the same guards as the page list.
  it('leaves Table Topics paths alone on other hosts, over http and without ROOT_ORIGIN', () => {
    expect(target('https://zoom.timer.simple-tech.app/tabletopics/', PROD)).toBeNull();
    expect(target('https://www.toastmusters.com/tabletopics/', PROD)).toBeNull();
    expect(target('http://www.timer.simple-tech.app/tabletopics/', PROD)).toBeNull();
    expect(target('https://www.timer.simple-tech.app/tabletopics/', {})).toBeNull();
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
  it.each([
    '/timer/app',
    '/timer',
    '/app',
    '/web',
    '/oauth/redirect',
    '/account',
    '/billing/success',
    '/club/admin',
    '/pro/ABC',
    '/r/ABCDEFGHJKMNPQRS',
    '/api/stats',
    '/zoom/',
    '/zoom/privacy.html',
    '/add-to-zoom',
    '/assets/index.js',
    '/robots.txt',
    '/sitemap.xml',
    '/llms.txt',
    '/404.html',
    '/does-not-exist',
  ])('keeps the path %s on the old host', (path) => {
    expect(target(`https://www.timer.simple-tech.app${path}`, PROD)).toBeNull();
  });
});
