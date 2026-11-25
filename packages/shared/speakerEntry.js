/**
 * On-the-spot speakers (#168): where a speaker added mid-meeting goes, what an
 * edit to the loaded speaker stages, and the words every speaker control shows.
 *
 * Pure, so the Zoom app's two looks (the Live tab panel and its stage, and
 * design B's speaker popover) and the web Live tab build their controls from the
 * same rules and say the same thing. Each surface draws its own buttons; none of
 * them decides here-or-there or Update-or-Add on its own.
 */

/** Where a new speaker goes: right after the loaded row (the default), or last. */
export const SPEAKER_INSERT_AFTER_ACTIVE = 'afterActive';
export const SPEAKER_INSERT_END = 'end';

/** What Enter does in the name field with a row loaded: update it (the default), or add a speaker. */
export const SPEAKER_ENTER_UPDATE = 'update';
export const SPEAKER_ENTER_ADD = 'add';

const nameOf = (row) => (row?.name || '').trim() || 'Unnamed';

/**
 * A new agenda with `item` right after the row `afterId`. Appends when there is
 * no such row, so a row deleted meanwhile still leaves the speaker somewhere.
 *
 * @param {Array<Object>} agenda
 * @param {string|null|undefined} afterId
 * @param {Object} item
 * @returns {Array<Object>} a new array; `agenda` is untouched
 */
export function insertAfter(agenda, afterId, item) {
  const index = afterId == null ? -1 : agenda.findIndex((row) => row.id === afterId);
  if (index < 0) return [...agenda, item];
  return [...agenda.slice(0, index + 1), item, ...agenda.slice(index + 1)];
}

/**
 * Where an added speaker goes and whether they go on the timer.
 *
 * Never on the timer while a speech is in progress (running, or paused with time
 * on the clock): loading them would reset the clock, the colour and the video in
 * front of the meeting. They wait on the agenda, and FINISH moves to them.
 *
 * @param {{speechActive?: boolean, insertPosition?: string, anchorId?: string|null}} options
 *   `anchorId` is the loaded row, or the row let go of for a quick timing.
 * @returns {{insertAfter: string|null, activate: boolean}}
 */
export function addPlan({ speechActive = false, insertPosition = SPEAKER_INSERT_AFTER_ACTIVE, anchorId = null } = {}) {
  return {
    insertAfter: insertPosition === SPEAKER_INSERT_END || !anchorId ? null : anchorId,
    activate: !speechActive,
  };
}

/**
 * What the name field and the role picker would change on the loaded row.
 * Spaces around the name do not count, and an emptied name is not a rename.
 *
 * @param {{row: Object|null, name: string, role: string}} fields
 * @returns {{name?: string, role?: string}|null} null when nothing is staged,
 *   and always with no row loaded (a quick timing labels the clock instead)
 */
export function pendingChanges({ row, name, role }) {
  if (!row) return null;
  const changes = {};
  const typed = (name || '').trim();
  if (typed && typed !== (row.name || '').trim()) changes.name = typed;
  if (role && role !== row.role) changes.role = role;
  return Object.keys(changes).length > 0 ? changes : null;
}

/**
 * The row still to speak under this exact name (any case), if any. A typed name
 * that matches one is never added a second time; a finished row does not count,
 * since someone who already spoke is often back later as an evaluator.
 *
 * @param {Array<Object>} agenda
 * @param {string} name
 * @returns {Object|null}
 */
export function findOnAgenda(agenda, name) {
  const typed = (name || '').trim().toLowerCase();
  if (!typed) return null;
  return (agenda || []).find((row) => !row.completed && (row.name || '').trim().toLowerCase() === typed) || null;
}

/**
 * What Enter in the name field does: 'update' the loaded row with what is
 * staged, 'add' the typed name as a new speaker (the setting on "add", and a
 * changed name that is not on the agenda yet), or nothing (null). Nothing with
 * no row loaded, whichever setting is on: the field just labels the timer then.
 *
 * @param {{agenda: Array<Object>, loadedRowId: string|null, name: string, role: string, enterAction?: string}} state
 * @returns {'update'|'add'|null}
 */
export function nameFieldAction({ agenda, loadedRowId, name, role, enterAction = SPEAKER_ENTER_UPDATE }) {
  const row = loadedRowId ? (agenda || []).find((item) => item.id === loadedRowId) || null : null;
  const changes = pendingChanges({ row, name, role });
  if (!changes) return null;
  if (enterAction === SPEAKER_ENTER_ADD && changes.name) {
    return findOnAgenda(agenda, changes.name) ? null : SPEAKER_ENTER_ADD;
  }
  return SPEAKER_ENTER_UPDATE;
}

/**
 * The words on every speaker control, so the three surfaces cannot drift apart.
 * A label is null when its control is not offered. Every action says what
 * tapping it does; the status (a dot, never a button) says where things stand.
 *
 * @param {{
 *   agenda: Array<Object>,
 *   loadedRowId: string|null,    the row on the timer (activeSpeakerId)
 *   releasedRowId: string|null,  the row let go of for a quick timing
 *   name: string, role: string,  what the name field and role picker show
 *   addName: string, addRole: string,  the add panel's own fields
 *   enterAction?: string, insertPosition?: string,
 *   speechActive?: boolean,      a speech is running or paused with time on the clock
 * }} state
 * @returns {Object<string, string|null>}
 */
export function actionLabels({
  agenda = [],
  loadedRowId = null,
  releasedRowId = null,
  name = '',
  role = '',
  addName = '',
  addRole = '',
  enterAction = SPEAKER_ENTER_UPDATE,
  insertPosition = SPEAKER_INSERT_AFTER_ACTIVE,
  speechActive = false,
} = {}) {
  const index = loadedRowId ? agenda.findIndex((row) => row.id === loadedRowId) : -1;
  const loaded = index >= 0 ? agenda[index] : null;
  const released = !loaded && releasedRowId ? agenda.find((row) => row.id === releasedRowId) || null : null;
  const anchor = loaded || released;
  const where = insertPosition === SPEAKER_INSERT_END || !anchor ? 'at the end' : `after ${nameOf(anchor)}`;
  const changes = pendingChanges({ row: loaded, name, role });
  const enter = nameFieldAction({ agenda, loadedRowId: loaded?.id ?? null, name, role, enterAction });
  const typed = (name || '').trim();
  const addTyped = (addName || '').trim();
  const canSave = !loaded && Boolean(typed) && !findOnAgenda(agenda, typed);
  // Adding never moves the timer off a speech in progress (addPlan).
  const addResult = speechActive ? 'This speech keeps running; they wait on the agenda' : 'They go on the timer';
  // Loading the row again resets the clock, so not while a quick timing is
  // under way: FINISH (which reports it) or RESET first.
  const canGoBack = Boolean(released) && !speechActive;

  const changeList = changes
    ? [
      changes.name && `name ${nameOf(loaded)} → ${changes.name}`,
      changes.role && `role → ${changes.role}`,
    ].filter(Boolean).join(' · ')
    : null;

  return {
    status: loaded ? `On the agenda · ${index + 1} of ${agenda.length}` : 'Not on the agenda',
    unsaved: changes ? 'Unsaved changes' : null,
    update: changes ? `Update ${nameOf(loaded)} on the agenda` : null,
    changes: changeList,
    // Only when Enter does update: with the setting on "add" and a name already
    // on the agenda, Enter does nothing.
    updateNote: enter === SPEAKER_ENTER_UPDATE ? 'Enter updates too' : null,
    undo: changes ? 'Undo changes' : null,
    undoNote: changes ? `Back to ${nameOf(loaded)}, ${loaded.role}; nothing saved` : null,
    enterAdd: enter === SPEAKER_ENTER_ADD ? `Add ${changes.name} ${where}` : null,
    enterAddNote: enter === SPEAKER_ENTER_ADD ? `Enter adds them; ${nameOf(loaded)} stays as is` : null,
    quickTiming: loaded ? 'Switch to quick timing' : null,
    quickTimingNote: loaded ? `${nameOf(loaded)} stays on the agenda, not ticked off` : null,
    backToAgenda: canGoBack ? 'Back to agenda' : null,
    backToAgendaNote: canGoBack ? `next: ${nameOf(released)}, ${released.role}` : null,
    save: canSave ? `Save ${typed} to the agenda` : null,
    saveNote: canSave ? `Goes ${where}. ${addResult}` : null,
    addOpener: `Add a speaker ${where}`,
    addOpenerNote: addResult,
    add: `Add ${addTyped ? `${addTyped} ` : ''}${where} as ${addRole || role}`,
    // The add panel's parts: its heading, and its button in two lines (who
    // goes where, then the role), which together read as `add`.
    addHead: `New speaker · goes ${where}`,
    addAction: `Add ${addTyped || 'speaker'} ${where}`,
    addAs: `as ${addRole || role}`,
    addTaken: addTyped && findOnAgenda(agenda, addTyped) ? `${addTyped} is already on the agenda` : null,
  };
}
