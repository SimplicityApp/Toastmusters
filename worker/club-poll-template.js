import { json, methodNotAllowed } from './http.js';
import { entitlementStore } from './entitlements.js';
import { clubPollTemplateKey } from './club-admin.js';
import { bumpVer, requirePublisher } from './club-cards.js';
import { capturePostHogEvent } from './posthog.js';

/**
 * The club's meeting poll template (#80): the ballot setup an admin or editor
 * publishes once, which every club device then sets its polls up from.
 *
 *   PUT /api/club/poll-template   {categories: [{role, label?, slots}],
 *                                  options: {postToChat, showOnStage, expiryHours}}
 *
 * Stored at `club-poll-template:<clubId>`; publishing bumps `club:<clubId>.ver`,
 * so devices replace their copy on the next refresh, the way presets and card
 * sets travel. A lapsed club keeps it stored; devices stop using it because the
 * club state says `entitled: false`, as they do for presets.
 */

const MAX_CATEGORIES = 10;
const MAX_SLOTS = 20;
const clip = (value) => (typeof value === 'string' ? value.trim().slice(0, 80) : '');

/**
 * The same shape packages/shared/polls.js normalizeTemplate keeps on the
 * device: a category with no role is dropped, unknown keys go.
 *
 * @returns {{categories: Array, options: Object}|null} null with no category left
 */
export function normalizePollTemplate(raw) {
  const categories = (Array.isArray(raw?.categories) ? raw.categories : [])
    .map((c) => {
      const label = clip(c?.label);
      const slots = Math.round(Number(c?.slots));
      return {
        role: clip(c?.role),
        ...(label ? { label } : {}),
        slots: Number.isFinite(slots) ? Math.min(MAX_SLOTS, Math.max(1, slots)) : 3,
      };
    })
    .filter((c) => c.role)
    .slice(0, MAX_CATEGORIES);
  if (!categories.length) return null;
  const options = raw?.options ?? {};
  const hours = Number(options.expiryHours);
  return {
    categories,
    options: {
      postToChat: typeof options.postToChat === 'boolean' ? options.postToChat : true,
      showOnStage: typeof options.showOnStage === 'boolean' ? options.showOnStage : false,
      expiryHours: Number.isFinite(hours) && hours > 0 ? Math.min(24, hours) : 24,
    },
  };
}

/** The club's published template, or null. Never throws: it runs on the app-start refresh. */
export async function readClubPollTemplate(env, clubId) {
  const store = entitlementStore(env);
  if (!store || !clubId) return null;
  try {
    return (await store.get(clubPollTemplateKey(clubId), 'json')) ?? null;
  } catch {
    return null;
  }
}

/** The template as a device stores it. */
export function buildPollTemplate(record) {
  const template = record ? normalizePollTemplate(record) : null;
  if (!template) return null;
  return { ...template, publishedBy: record.publishedBy ?? null, publishedAt: record.publishedAt ?? null };
}

/** PUT /api/club/poll-template */
export async function handleClubPollTemplate(request, env, { ctx } = {}) {
  if (request.method !== 'PUT') return methodNotAllowed();
  const context = await requirePublisher(request, env, { assets: false });
  if (context.response) return context.response;
  const { store, clubId, club, uid } = context;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }
  const template = normalizePollTemplate(body);
  if (!template) return json({ error: 'invalid_poll_template' }, 400);

  const record = { ...template, publishedBy: uid, publishedAt: Date.now() };
  await store.put(clubPollTemplateKey(clubId), JSON.stringify(record));
  const ver = await bumpVer(store, clubId, club);

  const capture = capturePostHogEvent(env, 'poll_template_published', {
    distinct_id: `club:${clubId}`,
    $process_person_profile: false,
    categories: template.categories.length,
  });
  if (typeof ctx?.waitUntil === 'function') ctx.waitUntil(capture);
  else await capture;

  return json({ ver, pollTemplate: buildPollTemplate(record) });
}
