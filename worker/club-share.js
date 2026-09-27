import crypto from 'node:crypto';
import { readClub } from './auth.js';
import { json, methodNotAllowed, unauthorized } from './http.js';
import { entitlementStore, readClubRecord, resolveAccess } from './entitlements.js';
import { verifiedClubId, buildKit } from './club.js';
import { CODE_ALPHABET } from './club-admin.js';
import { compactMeeting, meetingKey, meetingDate, parseMeetingId } from './club-meetings.js';

/**
 * A meeting that travels: an image and a link.
 *
 * The device renders both PNGs and uploads them; the Worker only stores and
 * serves them. That is deliberate — a crawler does not run JavaScript, so the
 * OG tags have to be in the bytes the Worker returns and the preview has to be
 * a real image at a real URL, and rather than build a second renderer in the
 * Worker we reuse the one the client needs anyway for "Copy image". Keeping one
 * renderer is what guarantees the chat preview can never drift from what the
 * timer saw when they tapped it.
 *
 *   report-share:<token>                      { clubId, meetingId, createdAt }
 *   report-share-by-meeting:<clubId>:<id>     <token>      ← so a second share reuses it
 *   R2  club/<clubId>/r-<token>.png           the 1200×630 preview — the OG image
 *   R2  club/<clubId>/r-<token>-full.png      the whole meeting, for downloading
 *
 * The token is minted lazily on the first share, so a meeting nobody shares has
 * no public address at all. The page is unguessable rather than secret: 16
 * Crockford base32 characters is ~80 bits, and it is served `noindex`.
 */

/** ~80 bits. Long enough that the page is not findable by trying. */
export const SHARE_TOKEN_LENGTH = 16;

/** One image is a report of a long meeting; four megabytes is already absurd. */
const MAX_SHARE_IMAGE_BYTES = 4 * 1024 * 1024;
/** A meeting title is a line like "Humorous Speech Contest", not an essay. */
const MAX_TITLE_LENGTH = 120;

/** Five minutes: long enough to absorb a link being pasted into a group chat. */
const SHARE_PAGE_CACHE = 'public, max-age=300';

export const shareKey = (token) => `report-share:${token}`;
export const shareByMeetingKey = (clubId, meetingId) => `report-share-by-meeting:${clubId}:${meetingId}`;
export const shareObjectName = (token) => `r-${token}.png`;
export const shareFullObjectName = (token) => `r-${token}-full.png`;
const shareObjectKey = (clubId, name) => `club/${clubId}/${name}`;

/** Whether a string is one of ours: exactly the alphabet, exactly the length. */
export function isShareToken(value) {
  const token = String(value ?? '');
  if (token.length !== SHARE_TOKEN_LENGTH) return false;
  for (const char of token) {
    if (!CODE_ALPHABET.includes(char)) return false;
  }
  return true;
}

/**
 * A fresh share token.
 *
 * Crockford base32 like the club codes, for one reason only: a token that ends
 * up read aloud or retyped from a screenshot should not turn an O into a 0.
 *
 * @param {() => number} [randomInt] - injectable for tests; returns 0..31
 */
export function mintShareToken(randomInt = () => crypto.randomInt(CODE_ALPHABET.length)) {
  let token = '';
  for (let i = 0; i < SHARE_TOKEN_LENGTH; i += 1) {
    token += CODE_ALPHABET[randomInt() % CODE_ALPHABET.length];
  }
  return token;
}

/** Where a shared report lives, absolutely, because an OG tag cannot be relative. */
function shareOrigin(request, env) {
  if (typeof env?.WEB_ORIGIN === 'string' && env.WEB_ORIGIN) return env.WEB_ORIGIN.replace(/\/+$/, '');
  try {
    return new URL(request.url).origin;
  } catch {
    return '';
  }
}

/** The counts the page and its preview description are built from. */
function countSpeeches(speeches) {
  const rows = Array.isArray(speeches) ? speeches : [];
  return {
    speeches: rows.length,
    overtime: rows.filter((speech) => speech?.color === 'red' || speech?.disqualified === true).length,
  };
}

/** Same shape the archive already writes into a meeting header's KV metadata. */
function meetingMetadata(meetingId, record) {
  const counts = countSpeeches(record?.speeches);
  return {
    meetingId,
    date: record?.date ?? meetingDate(meetingId),
    title: record?.title ?? null,
    speeches: counts.speeches,
    overtime: counts.overtime,
  };
}

async function readUpload(form, field) {
  const value = form.get(field);
  if (!value || typeof value === 'string' || typeof value.arrayBuffer !== 'function') return null;
  const bytes = new Uint8Array(await value.arrayBuffer());
  if (!bytes.byteLength || bytes.byteLength > MAX_SHARE_IMAGE_BYTES) return null;
  return bytes;
}

/**
 * POST /api/club/meetings/<meetingId>/share — end the meeting and publish it.
 *
 * A write path, so it reads the device record: a revoked device stops being
 * able to publish a page under the club's name, and stops consuming the club's
 * R2 quota, on its very next request.
 */
export async function shareMeeting(request, env, meetingId) {
  if (request.method !== 'POST') return methodNotAllowed();

  const claims = readClub(request, env);
  if (!claims) return unauthorized();
  if (!parseMeetingId(meetingId)) return json({ error: 'invalid_meeting' }, 400);

  const store = entitlementStore(env);
  if (!store) return json({ error: 'Club storage is not configured' }, 503);
  if (!env.CARD_ASSETS) return json({ error: 'Asset storage is not configured' }, 503);

  const clubId = await verifiedClubId(env, claims);
  if (!clubId) return json({ error: 'forbidden' }, 403);

  const club = await readClubRecord(env, clubId);
  if (!club) return json({ error: 'club_not_found' }, 404);
  const access = await resolveAccess(env, { clubId, club });
  if (!access.entitled) return json({ error: 'upgrade_required', entitlement: access }, 402);

  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: 'Invalid form data' }, 400);
  }

  const rawTitle = form.get('title');
  const title = typeof rawTitle === 'string' ? rawTitle.trim().slice(0, MAX_TITLE_LENGTH) : '';
  const [preview, full] = await Promise.all([readUpload(form, 'previewPng'), readUpload(form, 'png')]);

  // Closing the record is the first thing that happens, so the page and its
  // preview are always built from one key rather than a fan-out that a second
  // device might still be adding to.
  const compacted = await compactMeeting(env, clubId, meetingId);
  if (!compacted) return json({ error: 'not_found' }, 404);

  // The title is the one thing a share writes into the meeting itself, and the
  // only moment a meeting ever gets one.
  let record = compacted;
  if (title && title !== compacted.title) {
    record = { ...compacted, title };
    await store.put(meetingKey(clubId, meetingId), JSON.stringify(record), {
      metadata: meetingMetadata(meetingId, record),
    });
  }

  // Reusing the token keeps a link that is already in somebody's chat working
  // after the timer notices a typo in the title and shares again.
  let token = await store.get(shareByMeetingKey(clubId, meetingId)).catch(() => null);
  if (!isShareToken(token)) {
    token = mintShareToken();
    await store.put(shareKey(token), JSON.stringify({ clubId, meetingId, createdAt: Date.now() }));
    await store.put(shareByMeetingKey(clubId, meetingId), token);
  }

  const httpMetadata = { contentType: 'image/png' };
  await Promise.all([
    preview ? env.CARD_ASSETS.put(shareObjectKey(clubId, shareObjectName(token)), preview, { httpMetadata }) : null,
    full ? env.CARD_ASSETS.put(shareObjectKey(clubId, shareFullObjectName(token)), full, { httpMetadata }) : null,
  ]);

  const counts = countSpeeches(record.speeches);
  return json({
    token,
    url: `${shareOrigin(request, env)}/r/${token}`,
    // Public and immutable, which is what lets a crawler fetch it without a
    // credential and without waking the Worker.
    imageUrl: `/api/club-assets/${clubId}/${shareObjectName(token)}`,
    meetingId,
    title: record.title ?? null,
    ...counts,
  });
}

// ---------------------------------------------------------------------------
// The hosted page
// ---------------------------------------------------------------------------

const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const DATE_FORMAT = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' };

/** `2026-09-29` → `Tue, 29 Sep 2026`, in a fixed locale because this is server-rendered. */
function readableDate(value) {
  if (!value) return null;
  const when = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(when.getTime())) return null;
  return new Intl.DateTimeFormat('en-GB', { ...DATE_FORMAT, timeZone: 'UTC' }).format(when);
}

const RESULT_COLORS = { green: '#16a34a', yellow: '#eab308', red: '#dc2626', blue: '#2563eb' };

function speechRow(speech) {
  const dot = RESULT_COLORS[speech?.color];
  return `<tr>
      <td class="name">${escapeHtml(speech?.name)}</td>
      <td>${escapeHtml(speech?.role)}</td>
      <td class="time">${escapeHtml(speech?.duration)}</td>
      <td>${dot ? `<span class="dot" style="background:${dot}"></span>` : ''}${escapeHtml(
        speech?.disqualified ? 'Over' : speech?.color ?? ''
      )}</td>
      <td>${escapeHtml(speech?.comments)}</td>
    </tr>`;
}

/**
 * The shared report, as HTML a crawler can read without running anything.
 *
 * Inline styles and no script at all: the page has to render identically in a
 * link preview fetcher, in a browser with the SPA's bundle nowhere near it, and
 * in whatever in-app webview a WhatsApp tap opens.
 */
export function renderSharePage({ clubName, primaryColor, logoUrl, meeting, imageUrl, canonicalUrl, fullImageUrl }) {
  const speeches = Array.isArray(meeting?.speeches) ? meeting.speeches : [];
  const counts = countSpeeches(speeches);
  const printed = readableDate(meeting?.date);
  const heading = meeting?.title || 'Timing report';
  const summary = [
    `${counts.speeches} ${counts.speeches === 1 ? 'speech' : 'speeches'}`,
    ...(counts.overtime ? [`${counts.overtime} over time`] : []),
    ...(printed ? [printed] : []),
  ].join(' · ');
  const pageTitle = `${clubName} — ${heading}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(pageTitle)}</title>
<meta name="description" content="${escapeHtml(summary)}">
<meta name="robots" content="noindex">
<link rel="canonical" href="${escapeHtml(canonicalUrl)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${escapeHtml(pageTitle)}">
<meta property="og:description" content="${escapeHtml(summary)}">
<meta property="og:url" content="${escapeHtml(canonicalUrl)}">
<meta property="og:image" content="${escapeHtml(imageUrl)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${escapeHtml(imageUrl)}">
<style>
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px 16px 48px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; background: #f3f4f6; color: #111827; }
.sheet { max-width: 760px; margin: 0 auto; background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; overflow: hidden; }
.accent { height: 8px; background: ${escapeHtml(primaryColor)}; }
header { display: flex; gap: 14px; align-items: center; padding: 18px 20px; }
.mark { width: 52px; height: 52px; border-radius: 10px; background: ${escapeHtml(primaryColor)}; color: #fff; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 18px; overflow: hidden; flex: 0 0 auto; }
.mark img { width: 100%; height: 100%; object-fit: contain; }
h1 { font-size: 20px; margin: 0; }
.sub { color: #6b7280; font-size: 14px; margin: 4px 0 0; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { text-align: left; padding: 10px 12px; border-top: 1px solid #e5e7eb; }
th { background: #f9fafb; color: #6b7280; font-size: 12px; text-transform: uppercase; letter-spacing: .03em; }
td.name { font-weight: 600; }
td.time { font-variant-numeric: tabular-nums; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
.empty { padding: 28px 20px; color: #6b7280; }
footer { padding: 14px 20px; color: #6b7280; font-size: 13px; display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
footer a { color: #2563eb; }
.wrap { overflow-x: auto; }
</style>
</head>
<body>
<main class="sheet">
  <div class="accent"></div>
  <header>
    <div class="mark">${
      logoUrl ? `<img src="${escapeHtml(logoUrl)}" alt="">` : escapeHtml(initialsOf(clubName))
    }</div>
    <div>
      <h1>${escapeHtml(clubName)}</h1>
      <p class="sub">${escapeHtml(heading)}${printed ? ` · ${escapeHtml(printed)}` : ''}</p>
    </div>
  </header>
  ${
    speeches.length
      ? `<div class="wrap"><table>
    <thead><tr><th>Name</th><th>Role</th><th>Time</th><th>Result</th><th>Comments</th></tr></thead>
    <tbody>${speeches.map(speechRow).join('')}</tbody>
  </table></div>`
      : `<p class="empty">No speeches were timed in this meeting.</p>`
  }
  <footer>
    <span>${escapeHtml(summary)}</span>
    <span>${fullImageUrl ? `<a href="${escapeHtml(fullImageUrl)}">Download the image</a> · ` : ''}Timed with Toastmusters Timer</span>
  </footer>
</main>
</body>
</html>`;
}

function initialsOf(name) {
  return String(name ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join('');
}

/** A real 404, not the SPA shell: an unknown token is a page that never existed. */
function sharePageNotFound() {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Report not found</title><meta name="robots" content="noindex"></head><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;padding:48px;text-align:center;color:#374151"><h1 style="font-size:20px">That report link is not available</h1><p>Ask whoever shared it for a fresh link.</p></body></html>`,
    {
      status: 404,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'X-Robots-Tag': 'noindex',
        'Cache-Control': 'no-store',
      },
    }
  );
}

/**
 * GET /r/<token> — the hosted report.
 *
 * No credential of any kind, deliberately: its readers are a link-preview
 * fetcher and whoever the timer sent the link to, neither of which has anything
 * we could check. `noindex` with a short public cache — unguessable rather than
 * secret.
 */
export async function handleSharedReport(request, url, env) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed();

  const token = url.pathname.slice('/r/'.length).replace(/\/+$/, '');
  if (!isShareToken(token)) return sharePageNotFound();

  const store = entitlementStore(env);
  if (!store) return sharePageNotFound();

  const share = await store.get(shareKey(token), 'json').catch(() => null);
  if (!share?.clubId || !share?.meetingId) return sharePageNotFound();

  const [meeting, club] = await Promise.all([
    store.get(meetingKey(share.clubId, share.meetingId), 'json').catch(() => null),
    readClubRecord(env, share.clubId),
  ]);
  if (!meeting) return sharePageNotFound();

  const kit = buildKit(share.clubId, club);
  const origin = shareOrigin(request, env);
  const html = renderSharePage({
    clubName: kit?.name || club?.name || 'Toastmusters Timer',
    primaryColor: kit?.primaryColor || '#772432',
    logoUrl: kit?.logoUrl ? `${origin}${kit.logoUrl}` : null,
    meeting: { ...meeting, date: meeting.date ?? meetingDate(share.meetingId) },
    imageUrl: `${origin}/api/club-assets/${share.clubId}/${shareObjectName(token)}`,
    fullImageUrl: `${origin}/api/club-assets/${share.clubId}/${shareFullObjectName(token)}`,
    canonicalUrl: `${origin}/r/${token}`,
  });

  return new Response(request.method === 'HEAD' ? null : html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // Public, because a crawler has no session — but never indexed: the page
      // is unguessable, not secret, and the club did not ask to be published.
      'Cache-Control': SHARE_PAGE_CACHE,
      'X-Robots-Tag': 'noindex',
    },
  });
}
