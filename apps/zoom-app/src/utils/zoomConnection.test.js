import {
  CONNECTION_CONNECTED,
  CONNECTION_DEV,
  CONNECTION_OUTSIDE_ZOOM,
  CONNECTION_REVOKED,
  LAUNCH_BROWSER,
  LAUNCH_CLIENT,
  LAUNCH_UNKNOWN,
  isReturningUser,
  needsAttention,
  readLaunchContext,
  resolveConnectionState,
} from './zoomConnection';

function docWith(content) {
  const doc = document.implementation.createHTMLDocument('t');
  if (content !== null) {
    const meta = doc.createElement('meta');
    meta.setAttribute('name', 'zoom-launch');
    meta.setAttribute('content', content);
    doc.head.appendChild(meta);
  }
  return doc;
}

describe('readLaunchContext', () => {
  it('reads the marker the Worker stamped into the head', () => {
    expect(readLaunchContext(docWith('client'))).toBe(LAUNCH_CLIENT);
    expect(readLaunchContext(docWith('browser'))).toBe(LAUNCH_BROWSER);
  });

  // A shell served without the marker (the Vite dev server, or a copy cached
  // from before this shipped) must not masquerade as a known answer.
  it('reports unknown when the marker is missing or unrecognised', () => {
    expect(readLaunchContext(docWith(null))).toBe(LAUNCH_UNKNOWN);
    expect(readLaunchContext(docWith('nonsense'))).toBe(LAUNCH_UNKNOWN);
    expect(readLaunchContext(null)).toBe(LAUNCH_UNKNOWN);
  });
});

describe('resolveConnectionState', () => {
  it('is connected whenever the handshake succeeded, whatever the launch says', () => {
    for (const launch of [LAUNCH_CLIENT, LAUNCH_BROWSER, LAUNCH_UNKNOWN]) {
      expect(resolveConnectionState({ sdkReady: true, launch })).toBe(CONNECTION_CONNECTED);
    }
  });

  // The whole point of the Worker marker: inside the client, a refused
  // handshake can only mean Zoom took our authorization away.
  it('calls a failed handshake inside the Zoom client a revoked install', () => {
    expect(resolveConnectionState({ sdkReady: false, launch: LAUNCH_CLIENT })).toBe(CONNECTION_REVOKED);
  });

  it('calls a failed handshake in a browser tab an out-of-Zoom load', () => {
    expect(resolveConnectionState({ sdkReady: false, launch: LAUNCH_BROWSER })).toBe(CONNECTION_OUTSIDE_ZOOM);
  });

  it('treats an unmarked shell as out of Zoom rather than guessing revocation', () => {
    expect(resolveConnectionState({ sdkReady: false, launch: LAUNCH_UNKNOWN })).toBe(CONNECTION_OUTSIDE_ZOOM);
  });

  // `npm run dev` fails the handshake every time and its shell carries no
  // marker; nagging there would train everyone to ignore the notice.
  it('stays quiet on an unmarked shell in a dev build', () => {
    const state = resolveConnectionState({ sdkReady: false, launch: LAUNCH_UNKNOWN, isDev: true });

    expect(state).toBe(CONNECTION_DEV);
    expect(needsAttention(state)).toBe(false);
  });

  // `wrangler dev` serves a marked shell, so the marker still wins: that is the
  // only way to exercise this feature locally.
  it('still trusts a real marker in a dev build', () => {
    expect(resolveConnectionState({ sdkReady: false, launch: LAUNCH_CLIENT, isDev: true })).toBe(
      CONNECTION_REVOKED
    );
  });
});

describe('needsAttention', () => {
  it('is true only for the two states the organizer can fix', () => {
    expect(needsAttention(CONNECTION_REVOKED)).toBe(true);
    expect(needsAttention(CONNECTION_OUTSIDE_ZOOM)).toBe(true);
    expect(needsAttention(CONNECTION_CONNECTED)).toBe(false);
    expect(needsAttention(CONNECTION_DEV)).toBe(false);
  });
});

describe('isReturningUser', () => {
  function storage(entries) {
    return { getItem: (key) => (key in entries ? entries[key] : null) };
  }

  it('recognises an organizer who has saved work on this origin', () => {
    expect(isReturningUser(storage({ toastmaster_agenda: '[{"role":"Speaker 1"}]' }))).toBe(true);
    expect(isReturningUser(storage({ toastmaster_reports: '[{"name":"Ana"}]' }))).toBe(true);
  });

  // An empty collection is what a first run leaves behind, so it must not
  // trigger the "your data is safe" reassurance for someone with no data.
  it('does not count empty collections or an empty origin', () => {
    expect(isReturningUser(storage({}))).toBe(false);
    expect(isReturningUser(storage({ toastmaster_agenda: '[]', toastmaster_reports: '{}' }))).toBe(false);
  });

  it('survives storage being blocked outright', () => {
    const throwing = { getItem: () => { throw new Error('blocked'); } };
    expect(isReturningUser(throwing)).toBe(false);
    expect(isReturningUser(null)).toBe(false);
  });
});
