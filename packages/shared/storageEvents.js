/**
 * A single place to learn that stored state changed.
 *
 * Every setting in the app already funnels through the save* helpers in
 * storage.js, writeSettings in cardImages.js and savePromptState in
 * promptScheduler.js. Announcing writes from those three points means the sync
 * layer never has to be wired into a call site, and a new caller of an existing
 * setter is covered the day it is written.
 *
 * Deliberately not the `storage` DOM event: that one fires in *other* tabs, not
 * the one that made the change, which is exactly backwards for this.
 */

const listeners = new Set();

/**
 * Announce that a stored key changed in this tab.
 *
 * A listener must never be able to break a save — persisting the user's
 * settings matters more than telling anyone about it.
 *
 * @param {string} key - the storage key that was written or removed
 */
export function notifyLocalWrite(key) {
  for (const listener of listeners) {
    try {
      listener(key);
    } catch {
      // Ignored on purpose: see above.
    }
  }
}

/**
 * @param {(key: string) => void} listener
 * @returns {() => void} unsubscribe
 */
export function onLocalWrite(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test seam: drop every listener. */
export function resetLocalWriteListeners() {
  listeners.clear();
}
