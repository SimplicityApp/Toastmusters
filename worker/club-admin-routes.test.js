import crypto from 'node:crypto';
import { describe, it, expect, beforeEach } from 'vitest';
import { handleClub } from './club.js';
import { handleClubRoster, handleMemberRole, handleDeviceRevoke, handleClubKit } from './club-admin-routes.js';
import { createClubFromPending, clubDeviceKey, clubMemberKey } from './club-admin.js';
import { mintSessionToken } from './session-token.js';
import { mintClubToken } from './club-token.js';
import { ADMIN_COOKIE, mintAdminSession } from './club-magic.js';
import { clubKey } from './entitlements.js';

/**
 * The console. Both doors reach one permission check, and everything behind it
 * is an admin-only write to a record the earlier phases already enforce.
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

/**
 * A club with a buyer-admin, an editor, a plain member with two laptops, and a
 * guest device — the roster in the design doc, minus the names.
 */
async function seedClub() {
  const created = await createClubFromPending(
    env,
    { clubName: 'Downtown Speakers', uid: 'sarah', email: BILLING_EMAIL },
    { code: 'DTSP7K2QM9' }
  );
  clubId = created.clubId;

  await kv.put(clubMemberKey(clubId, 'james'), JSON.stringify({ role: 'editor', displayName: null, addedAt: 1, revokedAt: null }));
  await kv.put(clubMemberKey(clubId, 'priya'), JSON.stringify({ role: 'member', displayName: null, addedAt: 2, revokedAt: null }));

  const device = (id, uid, label, lastSeenAt) =>
    kv.put(clubDeviceKey(clubId, id), JSON.stringify({ label, uid, activatedAt: 1, lastSeenAt, revokedAt: null }));

  await device('d-sarah-1', 'sarah', 'Chrome · Windows', 900);
  await device('d-sarah-2', 'sarah', 'Safari · iOS', 500);
  await device('d-james', 'james', 'Chrome · macOS', 950);
  await device('d-priya', 'priya', 'Edge · Windows', 300);
  await device('d-guest', null, 'Firefox · Windows', 100);

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
});

/** Door 1: a Zoom session plus the club token the officer's browser holds. */
const zoomDoor = (uid, { deviceId = 'd-sarah-1' } = {}) => ({
  authorization: `Bearer ${mintSessionToken(uid, SIGNING_KEY)}`,
  'x-club': mintClubToken({ clubId, deviceId, uid, ver: 1 }, SIGNING_KEY),
});

/** Door 2: the cookie a spent magic link left behind. */
const billingDoor = () => ({
  cookie: `${ADMIN_COOKIE}=${mintAdminSession({ clubId, email: BILLING_EMAIL }, SIGNING_KEY)}`,
});

const rosterReq = (headers) => new Request('https://x/api/club/roster', { headers });
const roleReq = (uid, body, headers) =>
  new Request(`https://x/api/club/members/${uid}/role`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
const revokeReq = (deviceId, body, headers) =>
  new Request(`https://x/api/club/devices/${deviceId}/revoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
/** The dispatcher supplies the id from the path; these call the handler directly. */
const setRole = (uid, body, headers) => handleMemberRole(roleReq(uid, body, headers), env, uid);
const revokeDevice = (deviceId, body, headers) =>
  handleDeviceRevoke(revokeReq(deviceId, body, headers), env, deviceId);

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

  it('answers 401 for a session with no club token', async () => {
    await seedClub();
    const res = await handleClubRoster(
      rosterReq({ authorization: `Bearer ${mintSessionToken('sarah', SIGNING_KEY)}` }),
      env
    );
    expect(res.status).toBe(401);
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

    expect((await handleClubRoster(rosterReq(zoomDoor('james', { deviceId: 'd-james' })), env)).status).toBe(403);
    const kit = await handleClubKit(kitReq({ primaryColor: '#123456' }, zoomDoor('james', { deviceId: 'd-james' })), env);
    expect(kit.status).toBe(403);
  });

  it('refuses a plain member and a stranger', async () => {
    await seedClub();
    expect((await handleClubRoster(rosterReq(zoomDoor('priya', { deviceId: 'd-priya' })), env)).status).toBe(403);
    expect((await handleClubRoster(rosterReq(zoomDoor('nobody', { deviceId: 'd-guest' })), env)).status).toBe(403);
  });

  // Revoking a *person* clears their role, so it takes the console with it;
  // revoking a device is about what that laptop may do, not about who runs the
  // club, so an admin is not locked out of the console by one bad laptop.
  it('locks out an admin whose membership was revoked', async () => {
    await seedClub();
    await kv.put(clubMemberKey(clubId, 'sarah'), JSON.stringify({ role: 'admin', revokedAt: Date.now() }));
    expect((await handleClubRoster(rosterReq(zoomDoor('sarah')), env)).status).toBe(403);
  });
});

describe('GET /api/club/roster', () => {
  it('groups devices under their person and lists guests on their own', async () => {
    await seedClub();

    const res = await handleClubRoster(rosterReq(zoomDoor('sarah')), env);
    const body = await res.json();

    expect(body.club).toMatchObject({
      id: clubId,
      name: 'Downtown Speakers',
      code: 'DTSP-7K2QM9',
      billingEmail: BILLING_EMAIL,
    });
    expect(body.counts).toEqual({ devices: 5, people: 3, guestDevices: 1 });

    // Admin first, then editor, then member.
    expect(body.members.map((m) => [m.uid, m.role])).toEqual([
      ['sarah', 'admin'],
      ['james', 'editor'],
      ['priya', 'member'],
    ]);
    // Newest-seen device first, under the person it belongs to.
    expect(body.members[0].devices.map((d) => d.deviceId)).toEqual(['d-sarah-1', 'd-sarah-2']);
    expect(body.guestDevices.map((d) => d.deviceId)).toEqual(['d-guest']);
    expect(body.guestDevices[0].label).toBe('Firefox · Windows');
  });

  it('reports the plan alongside the roster', async () => {
    await seedClub();
    const body = await (await handleClubRoster(rosterReq(billingDoor()), env)).json();
    expect(body).toMatchObject({ plan: 'pro', entitled: true, role: 'admin' });
    expect(body.kit).toMatchObject({ name: 'Downtown Speakers', primaryColor: '#772432' });
  });

  it('still shows a device whose member record was never written', async () => {
    await seedClub();
    await kv.put(clubDeviceKey(clubId, 'd-orphan'), JSON.stringify({ label: 'Chrome · Linux', uid: 'ghost' }));

    const body = await (await handleClubRoster(rosterReq(zoomDoor('sarah')), env)).json();
    expect(body.members.find((m) => m.uid === 'ghost')).toMatchObject({ role: 'member' });
  });
});

describe('POST /api/club/members/<uid>/role', () => {
  it('promotes a member to editor', async () => {
    await seedClub();

    const res = await setRole('priya', { role: 'editor' }, zoomDoor('sarah'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ uid: 'priya', member: { role: 'editor', revokedAt: null } });
    expect(JSON.parse(kv.store.get(clubMemberKey(clubId, 'priya'))).role).toBe('editor');
  });

  it('grants a role to a uid the roster has never seen', async () => {
    await seedClub();
    expect((await setRole('newcomer', { role: 'editor' }, billingDoor())).status).toBe(200);
    expect(JSON.parse(kv.store.get(clubMemberKey(clubId, 'newcomer')))).toMatchObject({ role: 'editor' });
  });

  it('revoking a person marks every device linked to them', async () => {
    await seedClub();
    // Sarah is the buyer and holds two laptops; James takes the club on first,
    // because the last admin cannot be revoked.
    await setRole('james', { role: 'admin' }, billingDoor());

    const res = await setRole('sarah', { role: 'revoked' }, billingDoor());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ devicesRevoked: 2 });

    for (const id of ['d-sarah-1', 'd-sarah-2']) {
      expect(JSON.parse(kv.store.get(clubDeviceKey(clubId, id))).revokedAt).toBeTypeOf('number');
    }
    // And nobody else's.
    expect(JSON.parse(kv.store.get(clubDeviceKey(clubId, 'd-james'))).revokedAt).toBeNull();
    expect(JSON.parse(kv.store.get(clubMemberKey(clubId, 'sarah'))).revokedAt).toBeTypeOf('number');
  });

  it('puts a revoked person back with one write', async () => {
    await seedClub();
    await setRole('priya', { role: 'revoked' }, billingDoor());

    const res = await setRole('priya', { role: 'member' }, billingDoor());
    expect(res.status).toBe(200);
    expect(JSON.parse(kv.store.get(clubMemberKey(clubId, 'priya'))).revokedAt).toBeNull();
  });

  // A club with nobody who can administer it needs a support ticket to fix.
  it('refuses to remove the last admin', async () => {
    await seedClub();

    const demote = await setRole('sarah', { role: 'editor' }, zoomDoor('sarah'));
    expect(demote.status).toBe(409);
    expect(await demote.json()).toEqual({ error: 'last_admin' });

    const revoke = await setRole('sarah', { role: 'revoked' }, zoomDoor('sarah'));
    expect(revoke.status).toBe(409);
    expect(JSON.parse(kv.store.get(clubMemberKey(clubId, 'sarah'))).role).toBe('admin');
  });

  it('allows the handover once a second admin exists', async () => {
    await seedClub();
    await setRole('james', { role: 'admin' }, zoomDoor('sarah'));

    expect((await setRole('sarah', { role: 'member' }, zoomDoor('sarah'))).status).toBe(200);
  });

  it('refuses a role it does not recognise', async () => {
    await seedClub();
    const res = await setRole('priya', { role: 'owner' }, billingDoor());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_role' });
  });

  it('refuses a non-admin', async () => {
    await seedClub();
    const res = await setRole('priya', { role: 'editor' }, zoomDoor('james', { deviceId: 'd-james' }));
    expect(res.status).toBe(403);
    expect(JSON.parse(kv.store.get(clubMemberKey(clubId, 'priya'))).role).toBe('member');
  });
});

describe('POST /api/club/devices/<id>/revoke', () => {
  it('marks exactly one row', async () => {
    await seedClub();

    const res = await revokeDevice('d-guest', undefined, zoomDoor('sarah'));
    expect(res.status).toBe(200);
    expect(JSON.parse(kv.store.get(clubDeviceKey(clubId, 'd-guest'))).revokedAt).toBeTypeOf('number');
    expect(JSON.parse(kv.store.get(clubDeviceKey(clubId, 'd-priya'))).revokedAt).toBeNull();
  });

  it('puts a device back when the wrong row was tapped', async () => {
    await seedClub();
    await revokeDevice('d-guest', undefined, billingDoor());

    const res = await revokeDevice('d-guest', { revoked: false }, billingDoor());
    expect(res.status).toBe(200);
    expect(JSON.parse(kv.store.get(clubDeviceKey(clubId, 'd-guest'))).revokedAt).toBeNull();
  });

  it('404s on a device that is not this club\'s', async () => {
    await seedClub();
    expect((await revokeDevice('d-nope', undefined, billingDoor())).status).toBe(404);
  });

  it('refuses a non-admin', async () => {
    await seedClub();
    const res = await revokeDevice('d-guest', undefined, zoomDoor('james', { deviceId: 'd-james' }));
    expect(res.status).toBe(403);
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
      (await call('/api/club/devices/d-guest/revoke', { method: 'POST', headers: billingDoor() })).status
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
    expect((await call('/api/club/devices/d-guest', { method: 'POST', headers: billingDoor() })).status).toBe(404);
  });

  it('refuses the wrong method', async () => {
    await seedClub();
    expect((await call('/api/club/roster', { method: 'POST', headers: billingDoor() })).status).toBe(405);
    expect((await call('/api/club/kit', { headers: billingDoor() })).status).toBe(405);
  });
});
