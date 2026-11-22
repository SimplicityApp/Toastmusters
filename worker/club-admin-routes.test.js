import crypto from 'node:crypto';
import { describe, it, expect, beforeEach } from 'vitest';
import { handleClub } from './club.js';
import { handleClubRoster, handleMemberRole, handleMemberName, handleMemberBlock, handleClubKit } from './club-admin-routes.js';
import { createClubFromPending, clubMemberKey, clubOfKey } from './club-admin.js';
import { mintSessionToken } from './session-token.js';
import { ADMIN_COOKIE, mintAdminSession } from './club-magic.js';
import { clubKey } from './entitlements.js';
import { makeClubPlacesNamespace } from './club-places-fake.js';

/**
 * The console. Both doors reach one permission check, and everything behind it
 * is an admin-only write to the member rows every club route reads. The
 * membership rules themselves (Remove, Block, the owner, the place count) are
 * in club-membership-admin.test.js.
 */

const SIGNING_KEY = 'test-session-signing-key';
const BILLING_EMAIL = 'treasurer@downtownspeakers.org';

function makeKv(seed = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  return {
    store,
    get: async (key, type) => {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    put: async (key, value) => { store.set(key, value); },
    delete: async (key) => { store.delete(key); },
    list: async ({ prefix = '' } = {}) => ({
      keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
      list_complete: true,
    }),
  };
}

function makeBucket() {
  const store = new Map();
  return {
    store,
    get: async (key) => (store.has(key) ? { body: store.get(key), httpMetadata: {} } : null),
    put: async (key, bytes, options) => { store.set(key, { bytes, options }); },
    delete: async (key) => { store.delete(key); },
    list: async () => ({ objects: [], truncated: false }),
  };
}

let kv;
let env;
let clubId;

/** A member row and the account's index, the way a join leaves them. */
const member = (uid, row) =>
  Promise.all([
    kv.put(clubMemberKey(clubId, uid), JSON.stringify({ displayName: null, ...row })),
    kv.put(clubOfKey(uid), JSON.stringify({ clubId, at: 1 })),
  ]);

/**
 * A club owned by Sarah (its first admin), with an editor and a plain member —
 * the roster in the design doc, minus the names.
 */
async function seedClub() {
  const created = await createClubFromPending(
    env,
    { clubName: 'Downtown Speakers', uid: 'sarah', email: BILLING_EMAIL },
    { code: 'DTSP7K2QM9' }
  );
  clubId = created.clubId;

  await member('james', { role: 'editor', addedAt: 1 });
  await member('priya', { role: 'member', addedAt: 2 });

  return created;
}

beforeEach(() => {
  kv = makeKv();
  env = {
    PROFILES: kv,
    CARD_ASSETS: makeBucket(),
    SESSION_SIGNING_KEY: SIGNING_KEY,
    WEB_ORIGIN: 'https://www.timer.simple-tech.app',
    ENTITLEMENT_ENFORCE: '1',
  };
  env.CLUB_PLACES = makeClubPlacesNamespace(() => env);
});

/** Door 1: the Zoom session, and nothing else. */
const zoomDoor = (uid) => ({ authorization: `Bearer ${mintSessionToken(uid, SIGNING_KEY)}` });

/** Door 2: the cookie a spent magic link left behind. */
const billingDoor = () => ({
  cookie: `${ADMIN_COOKIE}=${mintAdminSession({ clubId, email: BILLING_EMAIL }, SIGNING_KEY)}`,
});

const rosterReq = (headers) => new Request('https://x/api/club/roster', { headers });
const postReq = (path, body, headers) =>
  new Request(`https://x/api/club/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
/** The dispatcher supplies the uid from the path; these call the handlers directly. */
const setRole = (uid, body, headers) => handleMemberRole(postReq(`members/${uid}/role`, body, headers), env, uid);
const setBlocked = (uid, body, headers) => handleMemberBlock(postReq(`members/${uid}/block`, body, headers), env, uid);

const kitReq = (body, headers) =>
  new Request('https://x/api/club/kit', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

// ---------------------------------------------------------------------------

describe('the two doors', () => {
  it('both reach the same check', async () => {
    await seedClub();

    const viaZoom = await handleClubRoster(rosterReq(zoomDoor('sarah')), env);
    const viaBilling = await handleClubRoster(rosterReq(billingDoor()), env);

    expect(viaZoom.status).toBe(200);
    expect(viaBilling.status).toBe(200);

    const a = await viaZoom.json();
    const b = await viaBilling.json();
    // They differ only in the actor they carry — which is what an audit trail
    // needs: a named member, or whoever holds the billing mailbox.
    expect(a.actor).toEqual({ type: 'zoom', uid: 'sarah' });
    expect(b.actor).toEqual({ type: 'billing', email: BILLING_EMAIL });
    expect(a.members).toEqual(b.members);
    expect(a.club).toEqual(b.club);
  });

  it('answers 401 with no credential at all', async () => {
    await seedClub();
    expect((await handleClubRoster(rosterReq({}), env)).status).toBe(401);
  });

  // *Manage your club* opens the system browser, which has the officer's
  // session and has never typed the club's code. The account names the club.
  it('lets a signed-in admin in with the session alone', async () => {
    await seedClub();
    const res = await handleClubRoster(rosterReq(zoomDoor('sarah')), env);
    expect(res.status).toBe(200);
    expect((await res.json()).actor).toEqual({ type: 'zoom', uid: 'sarah' });
  });

  // The index is a pointer; the member row is the authority.
  it('refuses an admin whose row no longer says admin', async () => {
    await seedClub();
    await member('james', { role: 'admin', addedAt: 1 });
    await kv.put(clubMemberKey(clubId, 'james'), JSON.stringify({ role: 'member', displayName: null, addedAt: 1 }));
    expect(await kv.get(clubOfKey('james'), 'json')).toMatchObject({ clubId });

    expect((await handleClubRoster(rosterReq(zoomDoor('james')), env)).status).toBe(403);
  });

  it('answers 403 for a session that administers nothing', async () => {
    await seedClub();
    expect((await handleClubRoster(rosterReq(zoomDoor('priya')), env)).status).toBe(403);
    expect((await handleClubRoster(rosterReq(zoomDoor('nobody')), env)).status).toBe(403);
  });

  it('refuses a billing cookie signed with another key', async () => {
    await seedClub();
    const res = await handleClubRoster(
      rosterReq({ cookie: `${ADMIN_COOKIE}=${mintAdminSession({ clubId, email: BILLING_EMAIL }, 'other-key')}` }),
      env
    );
    expect(res.status).toBe(401);
  });
});

describe('who may administer', () => {
  it('refuses an editor on the roster and on the kit', async () => {
    await seedClub();

    expect((await handleClubRoster(rosterReq(zoomDoor('james')), env)).status).toBe(403);
    const kit = await handleClubKit(kitReq({ primaryColor: '#123456' }, zoomDoor('james')), env);
    expect(kit.status).toBe(403);
  });

  it('locks out an admin who was blocked, or whose row is a legacy revoked one', async () => {
    await seedClub();
    await member('omar', { role: 'admin', addedAt: 3 });
    expect((await handleClubRoster(rosterReq(zoomDoor('omar')), env)).status).toBe(200);

    await kv.put(clubMemberKey(clubId, 'omar'), JSON.stringify({ role: 'admin', revokedAt: Date.now() }));
    expect((await handleClubRoster(rosterReq(zoomDoor('omar')), env)).status).toBe(403);

    await member('omar', { role: 'admin', addedAt: 3, blockedAt: Date.now() });
    expect((await handleClubRoster(rosterReq(zoomDoor('omar')), env)).status).toBe(403);
  });
});

describe('GET /api/club/roster', () => {
  it('lists people, the owner first, with the places they use', async () => {
    await seedClub();

    const res = await handleClubRoster(rosterReq(zoomDoor('sarah')), env);
    const body = await res.json();

    expect(body.club).toMatchObject({
      id: clubId,
      name: 'Downtown Speakers',
      code: 'DTSP-7K2QM9',
      billingEmail: BILLING_EMAIL,
    });
    // The owner is a person but takes no place.
    expect(body.counts).toEqual({ people: 3, placesUsed: 2, placesTotal: 3 });
    expect(body.members.map((m) => [m.uid, m.role, m.isOwner])).toEqual([
      ['sarah', 'admin', true],
      ['james', 'editor', false],
      ['priya', 'member', false],
    ]);
    expect(body.blocked).toEqual([]);
    expect(body).not.toHaveProperty('guestDevices');
  });

  it('reports the plan alongside the roster', async () => {
    await seedClub();
    const body = await (await handleClubRoster(rosterReq(billingDoor()), env)).json();
    expect(body).toMatchObject({ plan: 'pro', entitled: true, role: 'admin' });
    expect(body.kit).toMatchObject({ name: 'Downtown Speakers', primaryColor: '#772432' });
  });

  it('lists blocked accounts apart, and leaves legacy revoked rows out', async () => {
    await seedClub();
    await kv.put(clubMemberKey(clubId, 'spam'), JSON.stringify({ displayName: 'Spam', blockedAt: 5, blockedBy: null }));
    await kv.put(clubMemberKey(clubId, 'old'), JSON.stringify({ role: 'member', displayName: null, addedAt: 1, revokedAt: 2 }));

    const body = await (await handleClubRoster(rosterReq(billingDoor()), env)).json();
    expect(body.members.map((m) => m.uid)).toEqual(['sarah', 'james', 'priya']);
    expect(body.blocked).toEqual([{ uid: 'spam', displayName: 'Spam', blockedAt: 5 }]);
  });
});

describe('POST /api/club/members/<uid>/role', () => {
  it('promotes a member to editor', async () => {
    await seedClub();

    const res = await setRole('priya', { role: 'editor' }, zoomDoor('sarah'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ uid: 'priya', member: { role: 'editor' } });
    expect(JSON.parse(kv.store.get(clubMemberKey(clubId, 'priya'))).role).toBe('editor');
  });

  // A role here never creates a row: that would take a place without a join.
  it('refuses a uid that is not in the club', async () => {
    await seedClub();
    expect((await setRole('newcomer', { role: 'editor' }, billingDoor())).status).toBe(404);
    expect(kv.store.has(clubMemberKey(clubId, 'newcomer'))).toBe(false);
  });

  it('removes a person: the row and the index go, and the place is freed', async () => {
    await seedClub();

    const res = await setRole('priya', { role: 'revoked' }, billingDoor());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ uid: 'priya', removed: true });
    expect(kv.store.has(clubMemberKey(clubId, 'priya'))).toBe(false);
    expect(kv.store.has(clubOfKey('priya'))).toBe(false);
    expect((await (await handleClubRoster(rosterReq(billingDoor()), env)).json()).counts.placesUsed).toBe(1);
  });

  it('never changes the owner', async () => {
    await seedClub();

    for (const role of ['editor', 'revoked']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await setRole('sarah', { role }, zoomDoor('sarah'));
      expect(res.status).toBe(409);
      // eslint-disable-next-line no-await-in-loop
      expect(await res.json()).toEqual({ error: 'owner' });
    }
    expect(JSON.parse(kv.store.get(clubMemberKey(clubId, 'sarah'))).role).toBe('admin');
  });

  it('lets an admin step another admin down while the owner remains', async () => {
    await seedClub();
    await setRole('james', { role: 'admin' }, zoomDoor('sarah'));

    expect((await setRole('james', { role: 'member' }, zoomDoor('sarah'))).status).toBe(200);
  });

  it('refuses a role it does not recognise', async () => {
    await seedClub();
    const res = await setRole('priya', { role: 'owner' }, billingDoor());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_role' });
  });

  it('refuses a non-admin', async () => {
    await seedClub();
    const res = await setRole('priya', { role: 'editor' }, zoomDoor('james'));
    expect(res.status).toBe(403);
    expect(JSON.parse(kv.store.get(clubMemberKey(clubId, 'priya'))).role).toBe('member');
  });
});

describe('POST /api/club/members/<uid>/block', () => {
  it('blocks and unblocks, and refuses anything but a yes or a no', async () => {
    await seedClub();

    expect((await setBlocked('priya', { blocked: true }, billingDoor())).status).toBe(200);
    expect(JSON.parse(kv.store.get(clubMemberKey(clubId, 'priya')))).toMatchObject({ blockedAt: expect.any(Number) });

    expect((await setBlocked('priya', { blocked: false }, billingDoor())).status).toBe(200);
    expect(kv.store.has(clubMemberKey(clubId, 'priya'))).toBe(false);

    expect((await setBlocked('priya', { blocked: 'yes' }, billingDoor())).status).toBe(400);
  });

  it('leaves a live member alone on an unblock', async () => {
    await seedClub();
    expect((await setBlocked('priya', { blocked: false }, billingDoor())).status).toBe(200);
    expect(JSON.parse(kv.store.get(clubMemberKey(clubId, 'priya')))).toMatchObject({ role: 'member' });
  });
});

describe('POST /api/club/members/<uid>/name', () => {
  const setName = (uid, body, headers) => handleMemberName(postReq(`members/${uid}/name`, body, headers), env, uid);

  // Until this existed the roster labelled people with their raw Zoom uid,
  // because `displayName` was written null everywhere and nothing ever set it.
  it('labels a member without touching their role', async () => {
    await seedClub();

    const res = await setName('priya', { name: '  Priya (VPE) ' }, zoomDoor('sarah'));

    expect(res.status).toBe(200);
    expect(await kv.get(clubMemberKey(clubId, 'priya'), 'json')).toMatchObject({
      role: 'member',
      displayName: 'Priya (VPE)',
    });
  });

  it('clears the name again when the field is emptied', async () => {
    await seedClub();
    await setName('priya', { name: 'Priya' }, zoomDoor('sarah'));

    await setName('priya', { name: '  ' }, zoomDoor('sarah'));

    expect(await kv.get(clubMemberKey(clubId, 'priya'), 'json')).toMatchObject({ displayName: null });
  });

  it('refuses an essay, and anyone who is not an admin', async () => {
    await seedClub();

    expect((await setName('priya', { name: 'x'.repeat(61) }, zoomDoor('sarah'))).status).toBe(400);
    expect((await setName('priya', { name: 'Priya' }, zoomDoor('james'))).status).toBe(403);
  });
});

describe('PUT /api/club/kit', () => {
  const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  const pngHash = crypto.createHash('sha256').update(pngBytes).digest('hex');

  const multipart = (fields, file) => {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, String(value));
    if (file) form.append('logo', new Blob([file.bytes], { type: file.type }), 'logo.png');
    return form;
  };

  const uploadReq = (form, headers) =>
    new Request('https://x/api/club/kit', { method: 'PUT', headers, body: form });

  it('edits the name, the colour and the toggles, and bumps ver once', async () => {
    await seedClub();

    const res = await handleClubKit(
      kitReq({ name: 'Downtown Speakers Club', primaryColor: '#004165', showOnReports: false }, zoomDoor('sarah')),
      env
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ver: 2,
      kit: { name: 'Downtown Speakers Club', primaryColor: '#004165', showOnCards: true, showOnReports: false },
    });

    const stored = JSON.parse(kv.store.get(clubKey(clubId)));
    expect(stored).toMatchObject({ name: 'Downtown Speakers Club', ver: 2 });
    expect(stored.kit).toMatchObject({ primaryColor: '#004165', showOnReports: false });
  });

  // Bumping `ver` for a no-op would make every device in the club discard its
  // presets to receive the presets it already has.
  it('writes nothing when nothing changed', async () => {
    await seedClub();
    await handleClubKit(kitReq({ primaryColor: '#004165' }, billingDoor()), env);

    const res = await handleClubKit(kitReq({ primaryColor: '#004165' }, billingDoor()), env);
    expect(res.status).toBe(200);
    expect((await res.json()).ver).toBe(2);
    expect(JSON.parse(kv.store.get(clubKey(clubId))).ver).toBe(2);
  });

  it('stores the logo content-addressed and hands back its public URL', async () => {
    await seedClub();

    const res = await handleClubKit(
      uploadReq(multipart({ primaryColor: '#004165' }, { bytes: pngBytes, type: 'image/png' }), billingDoor()),
      env
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      kit: { logoHash: pngHash, logoUrl: `/api/club-assets/${clubId}/${pngHash}` },
    });
    expect(env.CARD_ASSETS.store.has(`club/${clubId}/${pngHash}`)).toBe(true);
    expect(env.CARD_ASSETS.store.get(`club/${clubId}/${pngHash}`).options.httpMetadata.contentType).toBe('image/png');
  });

  it('drops the object the kit stopped pointing at', async () => {
    await seedClub();
    await handleClubKit(uploadReq(multipart({}, { bytes: pngBytes, type: 'image/png' }), billingDoor()), env);

    const other = new Uint8Array([1, 2, 3, 4, 5]);
    await handleClubKit(uploadReq(multipart({}, { bytes: other, type: 'image/png' }), billingDoor()), env);

    expect(env.CARD_ASSETS.store.has(`club/${clubId}/${pngHash}`)).toBe(false);
    expect(env.CARD_ASSETS.store.size).toBe(1);
  });

  it('removes the logo on request', async () => {
    await seedClub();
    await handleClubKit(uploadReq(multipart({}, { bytes: pngBytes, type: 'image/png' }), billingDoor()), env);

    const res = await handleClubKit(kitReq({ removeLogo: true }, billingDoor()), env);
    expect((await res.json()).kit.logoUrl).toBeNull();
    expect(env.CARD_ASSETS.store.size).toBe(0);
  });

  // The asset route is public, same-origin and serves the stored content type:
  // an SVG logo would be a way to run script on the origin every session cookie
  // belongs to.
  it('refuses an SVG, and anything that is not an image', async () => {
    await seedClub();

    const svg = new TextEncoder().encode('<svg onload="alert(1)"></svg>');
    const res = await handleClubKit(uploadReq(multipart({}, { bytes: svg, type: 'image/svg+xml' }), billingDoor()), env);
    expect(res.status).toBe(415);
    expect(env.CARD_ASSETS.store.size).toBe(0);
  });

  it('refuses a logo that is too big', async () => {
    await seedClub();
    const huge = new Uint8Array(1024 * 1024 + 1);
    const res = await handleClubKit(uploadReq(multipart({}, { bytes: huge, type: 'image/png' }), billingDoor()), env);
    expect(res.status).toBe(413);
  });

  it('refuses a colour that is not a hex colour, and an empty name', async () => {
    await seedClub();
    expect((await handleClubKit(kitReq({ primaryColor: 'red' }, billingDoor()), env)).status).toBe(400);
    expect((await handleClubKit(kitReq({ name: '   ' }, billingDoor()), env)).status).toBe(400);
    expect(JSON.parse(kv.store.get(clubKey(clubId))).ver).toBe(1);
  });
});

describe('dispatch', () => {
  const call = (path, init) => {
    const url = new URL(`https://x${path}`);
    return handleClub(new Request(url, init), url, env);
  };

  it('routes every console path', async () => {
    await seedClub();

    expect((await call('/api/club/roster', { headers: billingDoor() })).status).toBe(200);
    expect(
      (await call('/api/club/members/priya/role', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...billingDoor() },
        body: JSON.stringify({ role: 'editor' }),
      })).status
    ).toBe(200);
    expect(
      (await call('/api/club/members/priya/name', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...billingDoor() },
        body: JSON.stringify({ name: 'Priya' }),
      })).status
    ).toBe(200);
    expect(
      (await call('/api/club/members/priya/block', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...billingDoor() },
        body: JSON.stringify({ blocked: true }),
      })).status
    ).toBe(200);
    expect(
      (await call('/api/club/kit', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', ...billingDoor() },
        body: JSON.stringify({ primaryColor: '#004165' }),
      })).status
    ).toBe(200);
  });

  it('404s on a tail it does not know', async () => {
    await seedClub();
    expect((await call('/api/club/members/priya/promote', { method: 'POST', headers: billingDoor() })).status).toBe(404);
    // There is no per-device route any more.
    expect((await call('/api/club/devices/d-guest/revoke', { method: 'POST', headers: billingDoor() })).status).toBe(404);
  });

  it('refuses the wrong method', async () => {
    await seedClub();
    expect((await call('/api/club/roster', { method: 'POST', headers: billingDoor() })).status).toBe(405);
    expect((await call('/api/club/kit', { headers: billingDoor() })).status).toBe(405);
  });
});
