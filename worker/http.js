/**
 * Small response helpers shared by the API handlers.
 *
 * Every API answer is per-user or per-request, so nothing here is cacheable:
 * the edge must never hand one caller's body to the next.
 */

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'private, no-store',
      ...headers,
    },
  });
}

export const unauthorized = () => json({ error: 'Unauthorized' }, 401);
export const methodNotAllowed = () => json({ error: 'Method not allowed' }, 405);
export const notConfigured = (what) => json({ error: `${what} is not configured` }, 503);
