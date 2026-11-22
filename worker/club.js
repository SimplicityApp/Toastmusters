import { readSession, proReleased } from './auth.js';
import { json, methodNotAllowed, notConfigured, notFound, unauthorized } from './http.js';
import { entitlementStore, readClubRecord, resolveAccess } from './entitlements.js';
import {
  normalizeCode,
  formatCode,
  clubByCodeKey,
  clubMemberKey,
  activeAdmins,
  clubOwnerUid,
  clearClubIndex,
  isLiveMember,
  memberClub,
  readMemberRole,
  writeClubIndex,
} from './club-admin.js';
import { CLUB_PLACES, clubPlaces, countPlaces } from './club-places.js';
import { createClubForSubscriber } from './club-create.js';
import { readClubName } from './billing.js';
import { createStripeClient } from './stripe.js';
import { handleClubPresets, readClubPresets } from './club-presets.js';
import { handleClubCards, readClubCards, buildCards } from './club-cards.js';
import { handleClubMeetings } from './club-meetings.js';
import { handleClubAdminRoutes } from './club-admin-routes.js';
import { handleMagicLinkRequest, handleClubManage, handleClubManageSignOut } from './club-magic.js';

/**
 * Joining a club with a Zoom account, and asking the club what it looks like
 * today.
 *
 * Club Pro belongs to accounts, not devices. POST /api/club/activate takes a
 * code from a signed-in account and makes it a member; from then on the club
 * follows that account through its session, on every computer and in every
 * browser it signs in to, with nothing stored per device. GET /api/club answers
 * with the same document on every app open. Splitting content from plan is the
 * point of the shape: content is versioned and replaces a device's copy only
 * when `ver` moves, while plan and `entitled` carry no version and are applied
 * every time — a club can lapse with nothing having been written, because a
 * grace window just expires against the clock.
 *
 * A club's code admits the owner plus up to 3 other accounts (worker/club-places.js
 * counts them), and an account is in one club at a time (`club-of:zoom:<uid>`).
 *
 * The doors into a club sit behind the `pro` release flag (worker/flags.js):
 * while it is off, activate, create, magic-link and manage answer a bare 404.
 * The refresh and every route that needs an existing club stay open, so an
 * account already in a club keeps working (see CLUB_DOORS below).
 */

/**
 * Codes are not usefully guessable (1.07 billion suffixes) but they are short
 * enough to be worth throttling anyway: entropy does nothing against a leaked
 * code, throttling does nothing against a short one, and they fail differently.
 */
async function throttled(request, env) {
  if (!env.CLUB_ACTIVATE_LIMITER?.limit) return false;
  const key = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';
  try {
    const { success } = await env.CLUB_ACTIVATE_LIMITER.limit({ key });
    return !success;
  } catch {
    // A limiter that is down must not take activation down with it.
    return false;
  }
}

/**
 * Unknown, rotated and lapsed codes all answer with this, and so does a code
 * entered by a blocked account, so probing cannot confirm that a club exists or
 * that someone was blocked from it — which is also the one line of copy the
 * product asks for: "That code isn't active. Check with your club officer."
 */
const invalidCode = () => json({ error: 'invalid_code' }, 400);

async function readJsonBody(request) {
  try {
    return (await request.json()) ?? {};
  } catch {
    return {};
  }
}

/** Toastmasters maroon: the kit's colour until a club chooses its own. */
export const DEFAULT_PRIMARY_COLOR = '#772432';

/**
 * Top-right, mirroring the Toastmasters International logo on the other side of
 * the card, and the only corner that stays visible in camera mode — the centre
 * and the bottom of that frame are where the organizer is.
 */
export const DEFAULT_BADGE_PLACEMENT = Object.freeze({ x: 0.8, y: 0.12, scale: 0.12 });

/**
 * The club's brand kit, as a device needs it: structured identity rather than
 * another image upload.
 *
 * The logo is handed over as a URL rather than a hash because its reader is a
 * canvas compositor and a report page, neither of which should have to know how
 * our object keys are built. Public and immutable, so the edge serves it.
 */
export function buildKit(clubId, club) {
  const name = String(club?.name ?? '').trim();
  if (!name) return null;
  const kit = club?.kit && typeof club.kit === 'object' ? club.kit : {};
  const logoHash = typeof kit.logoHash === 'string' && kit.logoHash ? kit.logoHash : null;
  return {
    name,
    logoHash,
    logoUrl: logoHash ? `/api/club-assets/${clubId}/${logoHash}` : null,
    primaryColor: typeof kit.primaryColor === 'string' && kit.primaryColor ? kit.primaryColor : DEFAULT_PRIMARY_COLOR,
    // Default on, both of them: a club that set a kit wants to see it, and a
    // club that has no kit never reaches here at all.
    showOnCards: kit.showOnCards !== false,
    showOnReports: kit.showOnReports !== false,
  };
}

/**
 * The club's badge placement — the default every device starts from.
 *
 * It rides along with the published presets because an admin sets it the same
 * way they set the presets: by positioning it on their own device and choosing
 * "Share with my club". A device that later moves it keeps that move in a key
 * of its own, so a republish reaches every device that never touched it.
 */
export function buildBadge(presets) {
  const badge = presets?.badge;
  if (!badge || typeof badge !== 'object') return { ...DEFAULT_BADGE_PLACEMENT };
  const number = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
  return {
    x: Math.min(1, Math.max(0, number(badge.x, DEFAULT_BADGE_PLACEMENT.x))),
    y: Math.min(1, Math.max(0, number(badge.y, DEFAULT_BADGE_PLACEMENT.y))),
    scale: Math.min(1, Math.max(0.01, number(badge.scale, DEFAULT_BADGE_PLACEMENT.scale))),
  };
}

/**
 * The officer's shareable activation link for a code.
 *
 * Built here rather than in each client because only the Worker knows the
 * canonical web host. Nothing in the product produced this link before, which
 * left the one documented way to discover the code field with no producer.
 */
export function shareUrlFor(env, code) {
  if (!env?.WEB_ORIGIN || !code) return null;
  try {
    return new URL(`/pro/${formatCode(code)}`, env.WEB_ORIGIN).toString();
  } catch {
    return null;
  }
}

/**
 * The whole club, as a device needs to see it.
 *
 * The split down the middle of this document is the point. Content — the
 * presets, the brand kit, the badge default and the card set — is versioned,
 * and a device replaces its copy only when `ver` moves, which is what lets a
 * timer's local list survive a refresh and lose only to an actual publish.
 * Everything below `timezone` carries no version and is applied every time,
 * because it can change with nothing having been written: a club lapses when a
 * grace window expires against the clock, and a member's role changes under a
 * different uid entirely.
 *
 * @param {Object} env
 * @param {string} clubId
 * @param {Object|null} club - the already-read club record
 * @param {Object} access - the combined entitlement from resolveAccess
 * @param {{uid?: string|null}} [caller] - whose role to report, if anyone's
 */
export async function buildClubState(env, clubId, club, access, { uid = null } = {}) {
  const [presets, cards, role, owner] = await Promise.all([
    readClubPresets(env, clubId),
    readClubCards(env, clubId),
    readMemberRole(env, clubId, uid),
    clubOwnerUid(env, club),
  ]);
  const isAdmin = role === 'admin';

  return {
    ver: club?.ver ?? 1,
    club: { id: clubId, name: club?.name ?? null },
    kit: buildKit(clubId, club),
    presets: presets
      ? {
        rules: presets.rules ?? {},
        order: presets.order ?? [],
        hiddenBuiltins: presets.hiddenBuiltins ?? [],
        publishedBy: presets.publishedBy ?? null,
        publishedAt: presets.publishedAt ?? null,
      }
      : null,
    badge: buildBadge(presets),
    cards: buildCards(cards),
    timezone: club?.timezone ?? null,
    // Not versioned: a promotion takes effect on the next refresh without
    // anything being republished.
    role,
    // The owner can't leave, so the apps hide Leave for them.
    isOwner: Boolean(uid) && uid === owner,
    // The code is the club's password, so only an admin is told it — but an
    // admin is told it *here*, on the refresh every surface already makes,
    // rather than only by the web console. Without this the one person who
    // needs to share the code cannot read it anywhere inside the Zoom app.
    code: isAdmin && club?.code ? formatCode(club.code) : null,
    shareUrl: isAdmin && club?.code ? shareUrlFor(env, club.code) : null,
    // Beside the code, for the same people: how many of the places it can
    // still fill.
    ...(isAdmin ? { placesUsed: await countPlaces(env, clubId), placesTotal: CLUB_PLACES } : {}),
    plan: access.plan,
    entitled: access.entitled,
    status: access.status,
    currentPeriodEnd: access.currentPeriodEnd,
    cancelAtPeriodEnd: access.cancelAtPeriodEnd,
    source: access.source,
  };
}

/** No session: joining, leaving and reading a club all need a Zoom account. */
const signInRequired = () => json({ error: 'sign_in_required' }, 401);
/** The place counter could not be reached; nothing was written. */
const tryAgain = () => json({ error: 'try_again' }, 503);

/**
 * POST /api/club/activate — a signed-in account types a code and joins.
 *
 * Public and rate-limited, and the session is checked before the code is even
 * looked up, so an anonymous caller learns nothing about which codes exist.
 * Then, in order:
 *
 *   own live row, or the owner      success, no new place
 *   blocked row                     invalid_code, like a wrong code
 *   already in another club         409 already_in_club, with its name
 *   no free place                   409 full
 *   otherwise                       a member row and the account's index
 *
 * The place is claimed before anything is written, so a join that cannot be
 * counted is a join that did not happen: an unreachable counter answers 503
 * and joins nobody.
 */
export async function handleClubActivate(request, env) {
  if (request.method !== 'POST') return methodNotAllowed();
  if (!env.SESSION_SIGNING_KEY) return notConfigured('Club activation');
  const store = entitlementStore(env);
  if (!store) return json({ error: 'Club storage is not configured' }, 503);

  if (await throttled(request, env)) return json({ error: 'too_many_attempts' }, 429);

  const session = readSession(request, env);
  if (!session?.uid) return signInRequired();
  const { uid } = session;

  const body = await readJsonBody(request);
  const code = normalizeCode(body?.code);
  if (!code) return invalidCode();

  let clubId;
  try {
    clubId = await store.get(clubByCodeKey(code));
  } catch {
    clubId = null;
  }
  if (!clubId) return invalidCode();

  const club = await readClubRecord(env, clubId);
  if (!club) return invalidCode();

  const access = await resolveAccess(env, { clubId, club });
  // A club that has lapsed is not a club anyone may join. Same failure as an
  // unknown code, on purpose.
  if (!access.entitled) return invalidCode();

  const [row, owner, current] = await Promise.all([
    store.get(clubMemberKey(clubId, uid), 'json').catch(() => null),
    clubOwnerUid(env, club),
    memberClub(env, uid),
  ]);

  if (row?.blockedAt) return invalidCode();
  if (current && current.clubId !== clubId) {
    return json({ error: 'already_in_club', clubName: current.club?.name ?? null }, 409);
  }

  const now = Date.now();
  let placesUsed;
  if (isLiveMember(row) || uid === owner) {
    // Re-entering the code: nothing to claim. An owner whose row is missing (a
    // club matched to its owner through Stripe) gets the admin row it implies.
    if (!isLiveMember(row)) {
      await store.put(clubMemberKey(clubId, uid), JSON.stringify({ role: 'admin', displayName: null, addedAt: now }));
    }
    if (!current) await writeClubIndex(store, uid, clubId, now);
    placesUsed = await countPlaces(env, clubId);
  } else {
    let claim;
    try {
      claim = await clubPlaces(env, clubId).claim(uid);
    } catch {
      return tryAgain();
    }
    if (!claim?.ok) {
      return json({ error: 'full', placesUsed: claim?.placesUsed ?? CLUB_PLACES, placesTotal: CLUB_PLACES }, 409);
    }
    try {
      await store.put(
        clubMemberKey(clubId, uid),
        // A removed account's name survives; a legacy revoked row is replaced.
        JSON.stringify({ role: 'member', displayName: row?.displayName ?? null, addedAt: now })
      );
      if (!current) await writeClubIndex(store, uid, clubId, now);
    } catch {
      // All or nothing: a row with no index, or a place with no row, is a
      // join that half happened. Take back the row, then the place.
      await store.delete(clubMemberKey(clubId, uid)).catch(() => {});
      await clubPlaces(env, clubId).release(uid).catch(() => {});
      return tryAgain();
    }
    placesUsed = claim.placesUsed;
  }

  return json({ ...(await buildClubState(env, clubId, club, access, { uid })), placesUsed });
}

/** Why a create was refused, in the words the officer reads. */
const CREATE_ERRORS = {
  not_a_subscriber: 403,
  no_billing_account: 409,
  creation_in_progress: 409,
  club_storage_unavailable: 503,
};

/**
 * POST /api/club/create — a subscriber mints the club their plan pays for.
 *
 * The club is the unit of Pro, but until this existed the only way to get one
 * was to name it at checkout and then wait for an operator to run the CLI. That
 * left every subscriber from before the club bundle — and everyone who skipped
 * the optional name field — paying for features they could not reach.
 *
 * Requires a session, because a club belongs to the person who pays for it.
 * Comp grants are deliberately not accepted: those stay operator-minted. The
 * creator is the owner and an admin from the moment the club exists, by
 * account, like every other member.
 */
export async function handleClubCreate(request, env) {
  if (request.method !== 'POST') return methodNotAllowed();
  if (!env.SESSION_SIGNING_KEY) return notConfigured('Club creation');

  const session = readSession(request, env);
  if (!session) return unauthorized();

  const body = await readJsonBody(request);
  const result = await createClubForSubscriber(env, {
    uid: session.uid,
    clubName: readClubName(body?.clubName),
    timezone: typeof body?.timezone === 'string' ? body.timezone.slice(0, 64) : null,
    stripe: createStripeClient(env),
  });

  if (!result.ok) return json({ error: result.error }, CREATE_ERRORS[result.error] ?? 500);

  const { clubId, club, code } = result;
  const access = await resolveAccess(env, { uid: session.uid, clubId, club });

  return json({
    created: result.created,
    ...(await buildClubState(env, clubId, club, access, { uid: session.uid })),
    // Last, so these win over the role-gated pair above. The member row making
    // this caller an admin was written moments ago and KV is eventually
    // consistent, so the role lookup inside buildClubState can still read null
    // — and the one request that must never fail to return the code is the one
    // that just minted it.
    code: formatCode(code),
    shareUrl: shareUrlFor(env, code),
  });
}

/**
 * POST /api/club/leave — this account is done with the club.
 *
 * Leaves everywhere the account is signed in, because that is where the club
 * is. The place is released first: if the counter can't be reached the answer
 * is 503 and nothing changes, so a retry is safe and a place is never left
 * held by someone who is gone. Then the member row and the index go, which
 * also lets the account rejoin with the code later.
 *
 * The owner can't leave (they end the club by cancelling the subscription),
 * and neither can the last admin of a club with no known owner. An account in
 * no club gets `left` anyway: it is leaving either way.
 */
export async function handleClubLeave(request, env) {
  if (request.method !== 'POST') return methodNotAllowed();

  const session = readSession(request, env);
  if (!session?.uid) return signInRequired();
  const { uid } = session;

  const store = entitlementStore(env);
  if (!store) return json({ error: 'Club storage is not configured' }, 503);

  const membership = await memberClub(env, uid);
  if (!membership) return json({ left: true });
  const { clubId, club, role } = membership;

  if (uid === (await clubOwnerUid(env, club))) return json({ error: 'owner' }, 409);
  if (role === 'admin' && (await activeAdmins(store, clubId)) <= 1) return json({ error: 'last_admin' }, 409);

  try {
    await clubPlaces(env, clubId).release(uid);
  } catch {
    return tryAgain();
  }
  try {
    await store.delete(clubMemberKey(clubId, uid));
  } catch {
    // Still a member: give the place back so the count stays exact.
    await clubPlaces(env, clubId).claim(uid).catch(() => {});
    return tryAgain();
  }
  await clearClubIndex(store, uid, clubId);
  return json({ left: true });
}

/**
 * GET /api/club — the club this account is in, on every app open.
 *
 * Found from the session alone. An account that left, was removed or was
 * blocked gets 404 `no_club`, which is how every device it is signed in on
 * loses the club's Pro on its next open. The plan is re-read every time, so a
 * club that lapsed overnight is off on the next app start, and the answer is
 * the *combined* one: a buyer who is also in a club must not be told they are
 * free.
 */
export async function handleClubState(request, env) {
  if (request.method !== 'GET') return methodNotAllowed();

  const session = readSession(request, env);
  if (!session?.uid) return signInRequired();

  const store = entitlementStore(env);
  if (!store) return json({ error: 'Club storage is not configured' }, 503);

  const membership = await memberClub(env, session.uid);
  if (!membership) return json({ error: 'no_club' }, 404);
  const { clubId, club } = membership;

  const access = await resolveAccess(env, { uid: session.uid, clubId, club });
  return json(await buildClubState(env, clubId, club, access, { uid: session.uid }));
}

/**
 * The routes that let someone into a club: joining with a code, minting one,
 * and the two halves of the mailed admin link. These, and only these, sit
 * behind the `pro` release flag (worker/flags.js).
 *
 * Everything else stays open on purpose. A 404 from GET /api/club makes the
 * client forget the club, and a 403/404 from the speech outbox makes it drop
 * the queued speech, so a blanket gate would evict club members and lose their
 * work the first time the flag went off. The other routes need a member's
 * session or an admin session, and while the flag is off nobody can become
 * either.
 */
const CLUB_DOORS = new Set(['activate', 'create', 'magic-link', 'manage']);

/**
 * Dispatch for /api/club and /api/club/*.
 *
 * @param {Request} request
 * @param {URL} url
 * @param {Object} env
 * @param {{ctx?: Object}} [deps] - ctx lets the flag answer be cached at the edge
 * @returns {Promise<Response>}
 */
export async function handleClub(request, url, env, { ctx } = {}) {
  const route = url.pathname.slice('/api/club'.length).replace(/^\/+|\/+$/g, '');

  // Ahead of every other answer, so a dark door cannot be told apart from a
  // mistyped URL — not even by a 401, a 405 or a "not configured" 503.
  if (CLUB_DOORS.has(route) && !(await proReleased(request, env, ctx))) {
    console.log('flag off: pro', route);
    return notFound();
  }

  if (route === '') return handleClubState(request, env);
  if (route === 'activate') return handleClubActivate(request, env);
  if (route === 'create') return handleClubCreate(request, env);
  if (route === 'leave') return handleClubLeave(request, env);
  if (route === 'presets') return handleClubPresets(request, env);
  if (route === 'cards' || route.startsWith('cards/')) return handleClubCards(request, route, env);
  if (route === 'meetings' || route.startsWith('meetings/')) return handleClubMeetings(request, route, env);

  // The console's second door. Public (and rate-limited) on the way in, so it
  // sits ahead of the admin routes, which all require a credential.
  if (route === 'magic-link') return handleMagicLinkRequest(request, env);
  if (route === 'manage') return handleClubManage(request, url, env);
  if (route === 'manage/signout') return handleClubManageSignOut(request);

  // roster, members/<uid>/role|name|block, kit.
  const admin = handleClubAdminRoutes(request, route, env);
  if (admin) return admin;

  return notFound();
}
