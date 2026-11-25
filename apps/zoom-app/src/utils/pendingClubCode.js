import { activateClub } from '@toastmaster-timer/shared';

/**
 * The club code a guest typed, kept until they approve the app.
 *
 * Joining a club needs a Zoom account that approved the app (#167). A guest who
 * types the code is asked to approve first, and the code waits here so they
 * never have to type it twice: the Pro panel sends it as soon as the identity
 * resolves again as authorized, or app start does on the next load.
 *
 * sessionStorage, not localStorage: the code is for this webview session, and
 * an approval that never comes should not leave a code lying around for good.
 */
export const PENDING_CLUB_CODE_KEY = 'toastmaster_pending_club_code';

export function savePendingClubCode(code) {
  try {
    sessionStorage.setItem(PENDING_CLUB_CODE_KEY, code);
  } catch {
    // Private mode: the user types the code again after approving.
  }
}

export function readPendingClubCode() {
  try {
    return sessionStorage.getItem(PENDING_CLUB_CODE_KEY) || null;
  } catch {
    return null;
  }
}

export function clearPendingClubCode() {
  try {
    sessionStorage.removeItem(PENDING_CLUB_CODE_KEY);
  } catch {
    // Nothing was stored.
  }
}

/**
 * Send the waiting code, if there is one, for an identity that can join.
 *
 * Forgotten once the server has answered either way; kept when the answer
 * never came (offline), so the next authorized open tries again.
 *
 * @param {Object} identity - what resolveZoomIdentity answered
 * @param {{getToken: () => string|null}} options
 * @returns {Promise<Object|null>} activateClub's result, or null when nothing was sent
 */
export async function joinWithPendingCode(identity, { getToken }) {
  const code = readPendingClubCode();
  if (!code || !identity?.identified || identity.authStatus !== 'authorized') return null;
  const result = await activateClub(code, { getToken, uid: identity.uid });
  if (result.ok || result.error !== 'network') clearPendingClubCode();
  return result;
}
