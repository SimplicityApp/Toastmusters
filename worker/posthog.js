/**
 * Server-side PostHog capture, shared by every Worker module that records an
 * event (the Zoom webhook, web sign-in).
 *
 * Release flags (flags.js) and stats (stats.js) talk to other PostHog endpoints
 * and keep their own fetch code; this is only the /capture/ door.
 */

export const POSTHOG_CAPTURE_URL = 'https://us.i.posthog.com/capture/';

/**
 * Send one event to PostHog's HTTP capture API.
 *
 * Never throws: analytics must not be able to break the request that records
 * it. With no POSTHOG_API_KEY it does nothing, so local runs and tests that do
 * not set the key never reach the network.
 *
 * Callers that should not hold their response for PostHog hand the returned
 * promise to `ctx.waitUntil` instead of awaiting it.
 *
 * @param {Object} env - POSTHOG_API_KEY
 * @param {string} eventName - snake_case event name
 * @param {Object} [properties] - event properties; `distinct_id` names the person
 * @param {{fetchImpl?: typeof fetch}} [options] - injectable fetch, for tests
 * @returns {Promise<void>}
 */
export async function capturePostHogEvent(env, eventName, properties = {}, { fetchImpl = fetch } = {}) {
  const apiKey = env?.POSTHOG_API_KEY;
  if (!apiKey) return;

  try {
    await fetchImpl(POSTHOG_CAPTURE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        event: eventName,
        properties: {
          // The webhook's historical fallback; every caller passes its own today.
          distinct_id: properties.distinct_id || 'zoom-webhook',
          ...properties,
        },
        timestamp: new Date().toISOString(),
      }),
    });
  } catch (err) {
    console.error('PostHog capture failed:', err?.message || err);
  }
}
