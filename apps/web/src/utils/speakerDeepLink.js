/**
 * "Time this" deep links: another tool (the Table Topics generator, say)
 * opens /timer?role=Table%20Topics%20Speech&name=<question> and the Live tab
 * starts with that speaker loaded. The role must match one of the timer's
 * role names exactly; nothing is guessed from free text.
 */

const MAX_NAME_LENGTH = 200;

/**
 * @param {string} search - `window.location.search`, with or without the `?`.
 * @param {string[]} validRoles - role names the Live tab can select.
 * @returns {{ role: string, name: string } | null}
 */
export function parseSpeakerFromSearch(search, validRoles) {
  if (typeof search !== 'string' || !Array.isArray(validRoles)) return null;
  const params = new URLSearchParams(search);
  const role = params.get('role');
  if (role === null || !validRoles.includes(role)) return null;
  const name = (params.get('name') ?? '').trim().slice(0, MAX_NAME_LENGTH);
  return { role, name };
}

/**
 * Drop `role` and `name` from the address bar once they have been consumed,
 * so a reload or a bookmark does not re-apply them. Other params and the hash
 * survive. No-op outside a browser or when neither param is present.
 */
export function stripSpeakerParams() {
  if (typeof window === 'undefined' || !window.history?.replaceState) return;
  const url = new URL(window.location.href);
  if (!url.searchParams.has('role') && !url.searchParams.has('name')) return;
  url.searchParams.delete('role');
  url.searchParams.delete('name');
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}
