/**
 * Merging one user's settings across the devices they run the timer from.
 *
 * Shared by the Worker and the browser on purpose: both sides run the exact
 * same merge, so "what the server decided" and "what the client expected" can
 * never drift apart into a bug nobody can reproduce.
 *
 * Per-field last-write-wins, not whole-document. A document-level merge would
 * let a laptop that has been closed for a week overwrite every preference set
 * on the desktop since, because its one stale write carries every field with
 * it. Each field carrying its own timestamp keeps an old device's staleness
 * confined to the fields it actually touched.
 */

/**
 * The localStorage keys that follow the user between devices.
 *
 * `toastmaster_reports` is deliberately absent. Report records carry no stable
 * id and no timestamp ({name, role, duration, color, comments, disqualified}),
 * so there is nothing to merge on: union by value would silently collapse two
 * genuinely different speakers who happen to match, and last-write-wins would
 * drop a meeting recorded on the other device. They are also per-meeting scratch
 * data with a clear operation that a union merge would keep undoing. Syncing
 * them would be worse than not syncing them until the records grow an id.
 */
export const SYNCED_KEYS = Object.freeze([
  'toastmaster_agenda',
  'toastmaster_role_rules',
  'toastmaster_role_order',
  'toastmaster_hidden_builtin_roles',
  'toastmaster_overlay_mode',
  'toastmaster_time_input_mode',
  'toastmaster_stage_clock_hidden',
  'toastmaster_reveal_face_when_idle',
  'toastmaster_overlay_time_readout',
  'toastmaster_prompts',
  'toastmaster_custom_card_images',
  // Which uploaded picture belongs to which card slot, so another device knows
  // what artwork to fetch. The pictures themselves live in R2, not here.
  'toastmaster_card_asset_hashes',
]);

const SYNCED = new Set(SYNCED_KEYS);

export const EMPTY_PROFILE = Object.freeze({ rev: 0, fields: {} });

/**
 * A field entry is `{ value, updatedAt }`. Anything else came from a client we
 * cannot reason about, and is dropped rather than merged on a guessed timestamp.
 */
function isValidEntry(entry) {
  return (
    entry !== null &&
    typeof entry === 'object' &&
    !Array.isArray(entry) &&
    typeof entry.updatedAt === 'number' &&
    Number.isFinite(entry.updatedAt) &&
    'value' in entry
  );
}

/**
 * Coerce anything into a profile document, so a corrupt or half-written value
 * in storage degrades to "no settings yet" instead of throwing on read.
 *
 * @param {any} raw
 * @returns {{rev: number, fields: Object}}
 */
export function normalizeProfile(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { rev: 0, fields: {} };

  const fields = {};
  const rawFields = raw.fields;
  if (rawFields && typeof rawFields === 'object' && !Array.isArray(rawFields)) {
    for (const key of Object.keys(rawFields)) {
      // Unknown keys are dropped rather than stored: without this the document
      // is an open-ended bucket any client can grow without limit.
      if (!SYNCED.has(key)) continue;
      if (isValidEntry(rawFields[key])) fields[key] = rawFields[key];
    }
  }

  return { rev: Number.isFinite(raw.rev) ? raw.rev : 0, fields };
}

/**
 * Merge an incoming document into a base, newest write per field wins.
 *
 * Ties go to the base. A tie means two devices wrote in the same millisecond,
 * which in practice means a client replayed what it already had — keeping the
 * base makes the merge idempotent, so retries cannot flip a field back and
 * forth.
 *
 * @param {any} base - the document already stored
 * @param {any} incoming - the document being written
 * @returns {{profile: {rev: number, fields: Object}, changed: boolean}}
 */
export function mergeProfiles(base, incoming) {
  const current = normalizeProfile(base);
  const next = normalizeProfile(incoming);

  const fields = { ...current.fields };
  let changed = false;

  for (const [key, entry] of Object.entries(next.fields)) {
    const existing = fields[key];
    if (!existing || entry.updatedAt > existing.updatedAt) {
      fields[key] = entry;
      changed = true;
    }
  }

  return {
    profile: { rev: changed ? current.rev + 1 : current.rev, fields },
    changed,
  };
}

/**
 * Decide what a device should adopt from the merged document.
 *
 * Returns only the fields where the remote copy is genuinely newer than what
 * this device has, so applying the result cannot clobber a local edit made
 * while the request was in flight.
 *
 * @param {any} localProfile - this device's field timestamps
 * @param {any} remoteProfile - the merged document from the server
 * @returns {Object<string, {value: any, updatedAt: number}>} fields to apply locally
 */
export function fieldsToApplyLocally(localProfile, remoteProfile) {
  const local = normalizeProfile(localProfile);
  const remote = normalizeProfile(remoteProfile);

  const toApply = {};
  for (const [key, entry] of Object.entries(remote.fields)) {
    const mine = local.fields[key];
    if (!mine || entry.updatedAt > mine.updatedAt) toApply[key] = entry;
  }
  return toApply;
}
