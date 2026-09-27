import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(join(repoRoot, relative), 'utf8');

/**
 * Every Content-Security-Policy the app serves, wherever it is defined.
 *
 * Three files, because the policy is set in three places and they have drifted
 * before: the Cloudflare Worker serves it in production, and the two vercel.json
 * files carry their own copies.
 */
function policies() {
  const found = [];
  for (const path of ['worker/index.js', 'vercel.json', 'apps/zoom-app/vercel.json']) {
    const source = read(path);
    // Every policy is a double-quoted string — a JSON value or a JS literal —
    // and contains only single quotes inside ('self', 'unsafe-inline'), so the
    // closing double quote is where it ends. Anchored on default-src, which
    // every one of them opens with.
    for (const match of source.matchAll(/"(default-src[^"]*)"/g)) {
      found.push({ path, policy: match[1] });
    }
  }
  return found;
}

describe('the Content-Security-Policy the app ships', () => {
  it('is defined in every place that serves one', () => {
    // A guard on the test itself: a policy that moved or was renamed would
    // otherwise make every assertion below pass by finding nothing.
    const paths = new Set(policies().map((entry) => entry.path));
    expect(paths).toEqual(
      new Set(['worker/index.js', 'vercel.json', 'apps/zoom-app/vercel.json'])
    );
  });

  it('lets the page display the images the organizer uploads', () => {
    // Uploaded card artwork and the organizer's own background are held as
    // Blobs and shown through object URLs, so an img-src without blob: blocks
    // every one of them. It did, and the symptom was not obviously a CSP
    // problem: fileToCardBlob loads the upload into an Image to re-encode it,
    // the load was refused, and both uploaders reported "That file could not be
    // read as an image" — for files that were perfectly good. Stored images
    // could not be displayed or pushed to the video either, since they reach
    // both through the same object URLs.
    //
    // Not caught by anything else: the dev server sends no CSP at all, so this
    // is invisible until the app is deployed.
    for (const { path, policy } of policies()) {
      const imgSrc = policy.match(/img-src ([^;]*)/)?.[1];
      expect(imgSrc, `img-src missing from the policy in ${path}`).toBeDefined();
      expect(imgSrc, `img-src in ${path} must allow blob:`).toContain('blob:');
    }
  });

  it('lets the club logo load from our own origin', () => {
    // The brand kit's logo is served by the Worker at
    // /api/club-assets/<clubId>/<name> — same origin on every host the apps run
    // on, including zoom.<domain>, since that path is dispatched ahead of host
    // routing. So 'self' is the whole requirement, and naming it here is what
    // stops a future tightening of img-src taking the badge and the branded
    // report header down silently.
    for (const { path, policy } of policies()) {
      const imgSrc = policy.match(/img-src ([^;]*)/)?.[1];
      expect(imgSrc, `img-src in ${path} must allow same-origin images`).toContain("'self'");
    }
  });
});

describe('the root policy the Worker serves', () => {
  // ROOT_CSP is the first policy in worker/index.js; ZOOM_CSP follows it and
  // deliberately stays stricter, so this reads the root one by name.
  const rootPolicy = read('worker/index.js').match(/const ROOT_CSP =\s*"(default-src[^"]*)"/)?.[1];

  it('is defined', () => {
    expect(rootPolicy).toBeDefined();
  });

  it('lets content pages load their Google Fonts', () => {
    // packages/ui/content-pages.css @imports Inter and Plus Jakarta Sans from
    // fonts.googleapis.com, which then serves the font files from
    // fonts.gstatic.com. A style-src without the first host silently drops the
    // whole stylesheet import; a font-src without the second drops the faces.
    // The dev server sends no CSP, so only production showed the fallback fonts.
    const styleSrc = rootPolicy.match(/style-src ([^;]*)/)?.[1];
    const fontSrc = rootPolicy.match(/font-src ([^;]*)/)?.[1];
    expect(styleSrc, 'style-src missing from ROOT_CSP').toBeDefined();
    expect(fontSrc, 'font-src missing from ROOT_CSP').toBeDefined();
    expect(styleSrc).toContain('https://fonts.googleapis.com');
    expect(fontSrc).toContain('https://fonts.gstatic.com');
  });
});
