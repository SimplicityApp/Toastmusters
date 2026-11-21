import { useEffect, useState } from 'react';
import { useFlag } from './useFlag';

/**
 * Device-local memory of the last `new_look` answer. Plain localStorage, not
 * the shared storage helpers: this is a rendering hint for this device, never
 * something to sync.
 */
export const NEW_LOOK_LAST_KEY = 'toastmaster_new_look_last';

function readLastAnswer() {
  try {
    return localStorage.getItem(NEW_LOOK_LAST_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Whether to draw the redesigned panel (design B).
 *
 * Flags arrive with the session response, a moment after the first paint. Until
 * then this answers what the server said last time on this device, so someone
 * on the new look does not see the old panel flash up at every open. A device
 * that has never had an answer starts on today's panel.
 *
 * @returns {boolean}
 */
export function useNewLook() {
  const { enabled, known } = useFlag('new_look');
  const [lastAnswer] = useState(readLastAnswer);

  useEffect(() => {
    if (!known) return;
    try {
      localStorage.setItem(NEW_LOOK_LAST_KEY, enabled ? '1' : '0');
    } catch {
      // Storage refused: the next open starts on today's panel until flags land.
    }
  }, [known, enabled]);

  return known ? enabled : lastAnswer;
}
