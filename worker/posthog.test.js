import { describe, it, expect, vi, afterEach } from 'vitest';
import { capturePostHogEvent, POSTHOG_CAPTURE_URL } from './posthog.js';

const env = { POSTHOG_API_KEY: 'phc_test' };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('capturePostHogEvent', () => {
  it('POSTs one event to the capture API with the key, name, properties and a timestamp', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}'));
    await capturePostHogEvent(env, 'web_signin_failed', { distinct_id: 'signin:n1', reason: 'profile' }, { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(POSTHOG_CAPTURE_URL);
    expect(url).toBe('https://us.i.posthog.com/capture/');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(init.body);
    expect(body).toEqual({
      api_key: 'phc_test',
      event: 'web_signin_failed',
      properties: { distinct_id: 'signin:n1', reason: 'profile' },
      timestamp: expect.any(String),
    });
    expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
  });

  it('falls back to the webhook distinct id when none is given', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}'));
    await capturePostHogEvent(env, 'zoom_meeting_started', {}, { fetchImpl });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).properties.distinct_id).toBe('zoom-webhook');
  });

  it('does nothing without an API key', async () => {
    const fetchImpl = vi.fn();
    await capturePostHogEvent({}, 'web_signin_succeeded', { distinct_id: 'zoom:u1' }, { fetchImpl });
    await capturePostHogEvent(undefined, 'web_signin_succeeded', {}, { fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('swallows a failed fetch and logs it, never throwing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });
    await expect(capturePostHogEvent(env, 'web_signin_failed', {}, { fetchImpl })).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith('PostHog capture failed:', 'network down');
  });

  it('uses the global fetch when none is injected', async () => {
    const globalFetch = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', globalFetch);
    try {
      await capturePostHogEvent(env, 'zoom_app_uninstalled', { distinct_id: 'u1' });
      expect(globalFetch).toHaveBeenCalledWith(POSTHOG_CAPTURE_URL, expect.objectContaining({ method: 'POST' }));
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
