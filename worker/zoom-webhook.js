import { verifyZoomSignature, generateCrcResponse } from './zoom-verify.js';
import { purgeUserData } from './user-data.js';

/** JSON Response helper. */
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Send an event to PostHog via the HTTP capture API.
 */
async function capturePostHogEvent(env, eventName, properties = {}) {
  const apiKey = env.POSTHOG_API_KEY;
  if (!apiKey) return;

  try {
    await fetch('https://us.i.posthog.com/capture/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        event: eventName,
        properties: {
          distinct_id: properties.distinct_id || 'zoom-webhook',
          ...properties,
        },
        timestamp: new Date().toISOString(),
      }),
    });
  } catch (err) {
    console.error('PostHog capture failed:', err.message);
  }
}

/**
 * Call Zoom's data compliance endpoint (required for Marketplace).
 */
async function notifyZoomCompliance(env, payload) {
  const clientId = env.ZOOM_CLIENT_ID;
  const clientSecret = env.ZOOM_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error('Missing ZOOM_CLIENT_ID or ZOOM_CLIENT_SECRET for compliance');
    return;
  }

  const deauthorizationPayload = payload.payload || payload;
  const userId = deauthorizationPayload.user_id;
  const accountId = deauthorizationPayload.account_id;

  try {
    // Get access token via client credentials
    const tokenRes = await fetch('https://zoom.us/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      },
      body: 'grant_type=client_credentials',
    });
    const tokenData = await tokenRes.json();

    await fetch('https://api.zoom.us/oauth/data/compliance', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenData.access_token}`,
      },
      body: JSON.stringify({
        client_id: clientId,
        user_id: userId,
        account_id: accountId,
        deauthorization_event_received: deauthorizationPayload,
        compliance_completed: true,
      }),
    });
  } catch (err) {
    console.error('Zoom compliance API call failed:', err.message);
  }
}

/**
 * Cloudflare Worker handler for Zoom webhooks.
 * POST /api/zoom/webhook
 *
 * Ported from api/zoom/webhook.js (Vercel req/res) to the Workers
 * (Request -> Response) model. Key differences:
 *  - secrets come from `env`, not process.env
 *  - the raw body is read once via request.text() and reused for both
 *    JSON parsing and signature verification (no req.body ambiguity)
 *  - fire-and-forget work uses ctx.waitUntil so the runtime doesn't cancel
 *    the pending promise after the response is sent
 */
export async function handleZoomWebhook(request, env, ctx) {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const rawBody = await request.text();
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const event = body.event;
  const secret = env.ZOOM_WEBHOOK_SECRET_TOKEN;

  // CRC validation — no signature check needed
  if (event === 'endpoint.url_validation') {
    const plainToken = body.payload?.plainToken;
    if (!plainToken) {
      return json({ error: 'Missing plainToken' }, 400);
    }
    try {
      return json(generateCrcResponse(plainToken, secret));
    } catch (err) {
      console.error('CRC validation failed:', err.message);
      return json({ error: err.message }, 500);
    }
  }

  // All other events require signature verification
  if (!verifyZoomSignature(request.headers, rawBody, secret)) {
    return json({ error: 'Invalid signature' }, 401);
  }

  // Handle specific events
  if (event === 'app_deauthorized') {
    const payload = body.payload;
    const userId = payload?.user_id;
    const accountId = payload?.account_id;

    // Zoom sends user_data_retention as the string "false" when the user asked
    // us to forget them. Synced settings and artwork go; the Stripe customer
    // link and any subscription record stay (billing history).
    const retain = String(payload?.user_data_retention ?? 'true') !== 'false';
    if (!retain && userId) {
      ctx.waitUntil(
        purgeUserData(env, userId)
          .then((r) => console.log('Purged user data on deauthorization:', userId, JSON.stringify(r)))
          .catch((err) => console.error('User data purge error:', err.message))
      );
    }

    await capturePostHogEvent(env, 'zoom_app_uninstalled', {
      distinct_id: userId || 'unknown',
      user_id: userId,
      account_id: accountId,
    });

    // Fire-and-forget compliance call (don't block the 3s response window).
    // ctx.waitUntil keeps the Worker alive until it settles.
    ctx.waitUntil(
      notifyZoomCompliance(env, body).catch((err) =>
        console.error('Compliance call error:', err.message)
      )
    );

    return json({ message: 'Uninstall tracked' });
  }

  if (event === 'meeting.started' || event === 'meeting.ended') {
    const payload = body.payload?.object || {};

    await capturePostHogEvent(env, `zoom_${event.replace('.', '_')}`, {
      distinct_id: payload.host_id || 'unknown',
      meeting_id: payload.id,
      host_id: payload.host_id,
      topic: payload.topic,
    });

    return json({ message: `${event} tracked` });
  }

  // Unknown events — log and return 200 (Zoom requires 200/204 within 3s)
  console.log('Unhandled Zoom webhook event:', event);
  return json({ message: 'Event received' });
}
