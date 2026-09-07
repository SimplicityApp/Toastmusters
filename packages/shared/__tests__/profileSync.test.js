import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  readLocalProfile,
  applyRemoteFields,
  pullProfile,
  pushProfile,
  initProfileSync,
  stopProfileSync,
} from '../profileSync.js';
import { saveOverlayMode, saveRoleRules } from '../storage.js';
import { resetLocalWriteListeners } from '../storageEvents.js';

const entry = (value, updatedAt) => ({ value, updatedAt });

function respondWith(profile, { ok = true } = {}) {
  return vi.fn(() => Promise.resolve({ ok, json: () => Promise.resolve({ profile }) }));
}

const withToken = (fetchImpl, token = 'tok') => ({ getToken: () => token, fetchImpl });

beforeEach(() => {
  localStorage.clear();
  resetLocalWriteListeners();
  vi.useFakeTimers();
});

afterEach(() => {
  stopProfileSync();
  vi.useRealTimers();
});

describe('readLocalProfile', () => {
  // A fresh device must not claim every setting is "absent as of now" — that
  // would delete settings that exist on the user's other machine.
  it('omits keys this device has neither written nor stored', () => {
    expect(readLocalProfile().fields).toEqual({});
  });

  it('reports stored values as raw strings, whatever their shape', () => {
    localStorage.setItem('toastmaster_overlay_mode', 'camera');
    localStorage.setItem('toastmaster_role_rules', '{"speech":5}');

    const { fields } = readLocalProfile();

    expect(fields.toastmaster_overlay_mode.value).toBe('camera');
    expect(fields.toastmaster_role_rules.value).toBe('{"speech":5}');
  });

  it('ignores keys outside the synced set', () => {
    localStorage.setItem('toastmaster_reports', '[{"name":"x"}]');

    expect(readLocalProfile().fields.toastmaster_reports).toBeUndefined();
  });
});

describe('applyRemoteFields', () => {
  it('writes remote values and remembers their timestamps', () => {
    const applied = applyRemoteFields({ toastmaster_overlay_mode: entry('card', 500) });

    expect(applied).toEqual(['toastmaster_overlay_mode']);
    expect(localStorage.getItem('toastmaster_overlay_mode')).toBe('card');
    expect(readLocalProfile().fields.toastmaster_overlay_mode).toEqual(entry('card', 500));
  });

  it('removes a key the server says was cleared', () => {
    localStorage.setItem('toastmaster_overlay_mode', 'camera');

    applyRemoteFields({ toastmaster_overlay_mode: entry(null, 500) });

    expect(localStorage.getItem('toastmaster_overlay_mode')).toBeNull();
  });

  it('leaves a key alone when the remote value is not a shape this app wrote', () => {
    localStorage.setItem('toastmaster_overlay_mode', 'camera');

    applyRemoteFields({ toastmaster_overlay_mode: entry({ unexpected: true }, 500) });

    expect(localStorage.getItem('toastmaster_overlay_mode')).toBe('camera');
  });
});

describe('pullProfile', () => {
  it('adopts fields that are newer on the server', async () => {
    const fetchImpl = respondWith({ rev: 1, fields: { toastmaster_overlay_mode: entry('card', 900) } });
    await initProfileSync(withToken(fetchImpl));

    expect(localStorage.getItem('toastmaster_overlay_mode')).toBe('card');
  });

  it('does not clobber a local value that is newer', async () => {
    applyRemoteFields({ toastmaster_overlay_mode: entry('mine', 9_000) });
    const fetchImpl = respondWith({ rev: 1, fields: { toastmaster_overlay_mode: entry('stale', 100) } });

    await initProfileSync(withToken(fetchImpl));

    expect(localStorage.getItem('toastmaster_overlay_mode')).toBe('mine');
  });

  // Guests and signed-out users are the normal case, not an error.
  it('does nothing and calls nothing without a session token', async () => {
    const fetchImpl = respondWith({ fields: {} });

    expect(await initProfileSync({ getToken: () => null, fetchImpl })).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('stays quiet when the network fails', async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error('offline')));

    await expect(initProfileSync(withToken(fetchImpl))).resolves.toEqual([]);
  });

  it('stays quiet when the endpoint errors', async () => {
    await expect(
      initProfileSync(withToken(respondWith({}, { ok: false })))
    ).resolves.toEqual([]);
  });
});

describe('pushProfile', () => {
  it('sends this device\'s fields with a bearer token', async () => {
    localStorage.setItem('toastmaster_overlay_mode', 'camera');
    const fetchImpl = respondWith({ rev: 1, fields: {} });

    await initProfileSync(withToken(fetchImpl));
    fetchImpl.mockClear();
    await pushProfile();

    const [, init] = fetchImpl.mock.calls[0];
    expect(init.method).toBe('PUT');
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body).profile.fields.toastmaster_overlay_mode.value).toBe('camera');
  });

  it('adopts a value the merge says is newer elsewhere', async () => {
    localStorage.setItem('toastmaster_overlay_mode', 'mine');
    const fetchImpl = respondWith({ rev: 2, fields: { toastmaster_overlay_mode: entry('theirs', 9_999) } });
    await initProfileSync(withToken(fetchImpl));

    await pushProfile();

    expect(localStorage.getItem('toastmaster_overlay_mode')).toBe('theirs');
  });

  it('sends nothing when there is nothing to send', async () => {
    const fetchImpl = respondWith({ fields: {} });
    await initProfileSync(withToken(fetchImpl));
    fetchImpl.mockClear();

    await pushProfile();

    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('reacting to local edits', () => {
  it('pushes after a debounce when a synced setting changes', async () => {
    const fetchImpl = respondWith({ rev: 1, fields: {} });
    await initProfileSync(withToken(fetchImpl));
    fetchImpl.mockClear();

    saveOverlayMode('card');
    expect(fetchImpl).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  // Dragging the readout would otherwise be one request per pixel.
  it('collapses a burst of edits into a single push', async () => {
    const fetchImpl = respondWith({ rev: 1, fields: {} });
    await initProfileSync(withToken(fetchImpl));
    fetchImpl.mockClear();

    saveOverlayMode('card');
    saveOverlayMode('camera');
    saveRoleRules({ speech: 5 });
    await vi.advanceTimersByTimeAsync(2000);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  // Adopting someone else's change must not look like a local edit, or two
  // devices would push each other's values back and forth forever.
  it('does not push in response to applying a remote change', async () => {
    const fetchImpl = respondWith({ rev: 1, fields: { toastmaster_overlay_mode: entry('card', 900) } });
    await initProfileSync(withToken(fetchImpl));
    fetchImpl.mockClear();

    await vi.advanceTimersByTimeAsync(2000);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('ignores writes to keys that are not synced', async () => {
    const fetchImpl = respondWith({ rev: 1, fields: {} });
    await initProfileSync(withToken(fetchImpl));
    fetchImpl.mockClear();

    localStorage.setItem('toastmaster_reports', '[]');
    await vi.advanceTimersByTimeAsync(2000);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('stops pushing once sync is stopped', async () => {
    const fetchImpl = respondWith({ rev: 1, fields: {} });
    await initProfileSync(withToken(fetchImpl));
    fetchImpl.mockClear();

    saveOverlayMode('card');
    stopProfileSync();
    await vi.advanceTimersByTimeAsync(2000);

    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
