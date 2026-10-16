import { render } from '@testing-library/react';

vi.mock('../utils/posthog', () => ({ trackEvent: vi.fn() }));

// The module remembers whether the API script has loaded, so each test imports a fresh copy
// after setting up the stub it wants.
async function load() {
  vi.resetModules();
  const { trackEvent } = await import('../utils/posthog');
  const { default: YouTubePlayer } = await import('./YouTubePlayer');
  return { YouTubePlayer, trackEvent };
}

function stubApi() {
  const instances = [];
  class Player {
    constructor(el, opts) { this.el = el; this.opts = opts; this.destroy = vi.fn(); instances.push(this); }
  }
  window.YT = { Player, PlayerState: { PLAYING: 1 } };
  return instances;
}

describe('YouTubePlayer', () => {
  afterEach(() => { delete window.YT; });

  it('keeps the 16:9 box on a parent the API will not replace, and sizes the iframe to fill it', async () => {
    const players = stubApi();
    const { YouTubePlayer } = await load();
    const { container } = render(<YouTubePlayer videoId="abc123" title="Demo" page="landing" />);
    await vi.waitFor(() => expect(players).toHaveLength(1));

    const box = container.firstChild;
    expect(box.style.aspectRatio).toBe('16/9');
    expect(box).toContainElement(players[0].el);
    expect(players[0].opts).toMatchObject({ videoId: 'abc123', width: '100%', height: '100%' });
  });

  it('starts on its own only when asked to', async () => {
    const players = stubApi();
    const { YouTubePlayer } = await load();
    render(<YouTubePlayer videoId="a" page="landing" />);
    render(<YouTubePlayer videoId="b" page="landing" autoplay />);
    await vi.waitFor(() => expect(players).toHaveLength(2));

    expect(players[0].opts.playerVars.autoplay).toBeUndefined();
    expect(players[1].opts.playerVars).toMatchObject({ autoplay: 1, playsinline: 1, rel: 0 });
  });

  it('reports the first play once, with the page, and destroys the player on unmount', async () => {
    const players = stubApi();
    const { YouTubePlayer, trackEvent } = await load();
    const { unmount } = render(<YouTubePlayer videoId="abc123" page="landing" />);
    await vi.waitFor(() => expect(players).toHaveLength(1));

    const { onStateChange } = players[0].opts.events;
    onStateChange({ data: 2 });
    onStateChange({ data: 1 });
    onStateChange({ data: 1 });
    expect(trackEvent).toHaveBeenCalledTimes(1);
    expect(trackEvent).toHaveBeenCalledWith('full_demo_played', { page: 'landing' });

    unmount();
    expect(players[0].destroy).toHaveBeenCalled();
  });
});
