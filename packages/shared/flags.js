/**
 * Which unreleased features this client may show, as the server decided it.
 *
 * The twin of entitlement.js. The Worker resolves release flags once per
 * session (see worker/flags.js) and they arrive in the same response as the
 * entitlement; this module only remembers that answer and tells the UI. There
 * is no polling and no focus listener, so a flag cannot change under someone
 * mid-meeting. Nothing here enforces anything either: a dark feature's
 * endpoints answer 404 whatever the client believes.
 */

// All off. The server's answer is the only truth, and a key it never sent is
// a feature this client does not show.
export const DEFAULT_FLAGS = Object.freeze({});

let current = DEFAULT_FLAGS;
// Until the first server answer we do not know, and a gated control should not
// appear and then vanish — the same reason entitlement.js has its `known`.
let known = false;
const listeners = new Set();

function normalize(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return DEFAULT_FLAGS;
  const flags = {};
  for (const [key, on] of Object.entries(value)) {
    // Only a literal true switches a feature on; anything else is off.
    flags[key] = on === true;
  }
  return Object.freeze(flags);
}

/** Record a fresh answer from the server and notify subscribers. */
export function setFlags(value) {
  current = normalize(value);
  known = true;
  for (const listener of listeners) {
    try {
      listener(current);
    } catch {
      // One bad subscriber must not stop the others hearing about it.
    }
  }
  return current;
}

export function getFlags() {
  return current;
}

/** @param {string} key */
export function isFlagOn(key) {
  return current[key] === true;
}

/** Whether any server answer has arrived yet. */
export function areFlagsKnown() {
  return known;
}

/**
 * @param {(flags: Object<string, boolean>) => void} listener
 * @returns {() => void} unsubscribe
 */
export function subscribeFlags(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test seam. */
export function resetFlagsForTests() {
  current = DEFAULT_FLAGS;
  known = false;
  listeners.clear();
}
