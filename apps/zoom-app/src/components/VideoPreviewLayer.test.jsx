import '@testing-library/jest-dom';
import { useRef } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import VideoPreviewLayer from './VideoPreviewLayer';

const KIT = { name: 'Claude Test Club', primaryColor: '#0f766e', logoUrl: null, showOnCards: true };

/** A 400×225 preview box, so pointer positions map to round fractions. */
function Harness(props) {
  const ref = useRef(null);
  return (
    <div
      ref={(node) => {
        ref.current = node;
        if (node) node.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 225, right: 400, bottom: 225 });
      }}
      style={{ position: 'relative' }}
    >
      <VideoPreviewLayer containerRef={ref} displayTime="01:23" {...props} />
    </div>
  );
}

const chip = () => screen.getByRole('button', { name: 'Drag to place the count-up participants see on your video' });
const badge = () => screen.getByRole('button', { name: "Drag to place your club's badge on your video" });

beforeAll(() => {
  // jsdom has no pointer capture.
  HTMLElement.prototype.setPointerCapture = () => {};
});

describe('VideoPreviewLayer', () => {
  it('follows a count-up drag live and hands it to Zoom once, on release', () => {
    const onReadoutPositionChange = vi.fn();
    render(<Harness readoutPosition={{ x: 0.5, y: 0.5 }} readoutVisible onReadoutPositionChange={onReadoutPositionChange} />);

    fireEvent.pointerDown(chip(), { pointerId: 1, clientX: 200, clientY: 112 });
    fireEvent.pointerMove(chip(), { pointerId: 1, clientX: 100, clientY: 45 });
    fireEvent.pointerMove(chip(), { pointerId: 1, clientX: 300, clientY: 180 });
    fireEvent.pointerUp(chip(), { pointerId: 1, clientX: 300, clientY: 180 });

    const commits = onReadoutPositionChange.mock.calls.filter(([, opts]) => opts.commit);
    expect(commits).toEqual([[{ x: 0.75, y: 0.8 }, { commit: true }]]);
    expect(onReadoutPositionChange).toHaveBeenCalledWith({ x: 0.25, y: 0.2 }, { commit: false });
  });

  it('clamps a drag that leaves the preview to its edge', () => {
    const onReadoutPositionChange = vi.fn();
    render(<Harness readoutPosition={{ x: 0.5, y: 0.5 }} readoutVisible onReadoutPositionChange={onReadoutPositionChange} />);

    fireEvent.pointerDown(chip(), { pointerId: 1 });
    fireEvent.pointerUp(chip(), { pointerId: 1, clientX: -50, clientY: 900 });
    expect(onReadoutPositionChange).toHaveBeenLastCalledWith({ x: 0, y: 1 }, { commit: true });
  });

  it('hides the size and eye buttons while the chip is being dragged', () => {
    render(<Harness readoutPosition={{ x: 0.5, y: 0.5 }} readoutVisible onReadoutPositionChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'Make the count-up larger' })).toBeInTheDocument();

    fireEvent.pointerDown(chip(), { pointerId: 1 });
    expect(screen.queryByRole('button', { name: 'Make the count-up larger' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Hide the count-up from your video' })).not.toBeInTheDocument();
  });

  it('sizes and hides the count-up, and offers only "show" once it is hidden', () => {
    const onAdjustReadoutScale = vi.fn();
    const onToggleReadoutVisible = vi.fn();
    const { rerender } = render(
      <Harness
        readoutPosition={{ x: 0.5, y: 0.5 }}
        readoutVisible
        onAdjustReadoutScale={onAdjustReadoutScale}
        onToggleReadoutVisible={onToggleReadoutVisible}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Make the count-up smaller' }));
    fireEvent.click(screen.getByRole('button', { name: 'Make the count-up larger' }));
    fireEvent.click(screen.getByRole('button', { name: 'Hide the count-up from your video' }));
    expect(onAdjustReadoutScale.mock.calls).toEqual([[-1], [1]]);
    expect(onToggleReadoutVisible).toHaveBeenCalledTimes(1);

    rerender(<Harness readoutPosition={{ x: 0.5, y: 0.5 }} readoutVisible={false} onToggleReadoutVisible={onToggleReadoutVisible} />);
    expect(screen.queryByRole('button', { name: 'Make the count-up larger' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show the count-up on your video' })).toBeInTheDocument();
  });

  it('draws no count-up where there is no frame to place it on', () => {
    render(<Harness readoutPosition={null} readoutVisible />);
    expect(screen.queryByRole('button', { name: /count-up/ })).not.toBeInTheDocument();
  });

  it('drags, sizes and hides the club badge, and offers the reset only once it was moved', () => {
    const onBadgePlacementChange = vi.fn();
    const onAdjustBadgeScale = vi.fn();
    const onToggleBadgeVisible = vi.fn();
    const onResetBadgePlacement = vi.fn();
    const placement = { x: 0.8, y: 0.12, scale: 0.12, visible: true };
    const props = { clubKit: KIT, badgePlacement: placement, onBadgePlacementChange, onAdjustBadgeScale, onToggleBadgeVisible, onResetBadgePlacement };
    const { rerender } = render(<Harness {...props} badgeMoved={false} />);

    expect(screen.queryByRole('button', { name: 'Reset to club position' })).not.toBeInTheDocument();
    fireEvent.pointerDown(badge(), { pointerId: 2 });
    fireEvent.pointerUp(badge(), { pointerId: 2, clientX: 40, clientY: 45 });
    expect(onBadgePlacementChange).toHaveBeenLastCalledWith({ x: 0.1, y: 0.2 }, { commit: true });

    fireEvent.click(screen.getByRole('button', { name: 'Make the club badge larger' }));
    fireEvent.click(screen.getByRole('button', { name: "Hide your club's badge on your video" }));
    expect(onAdjustBadgeScale).toHaveBeenCalledWith(1);
    expect(onToggleBadgeVisible).toHaveBeenCalledTimes(1);

    rerender(<Harness {...props} badgeMoved />);
    fireEvent.click(screen.getByRole('button', { name: 'Reset to club position' }));
    expect(onResetBadgePlacement).toHaveBeenCalledTimes(1);
  });

  it('in design B, keeps the chip and badge above the card text and every chip button inside near the right edge', () => {
    // 2026-11-16 Zoom run: at the bottom right the card's status line took the
    // − / + clicks, and the eye hung outside the panel.
    render(
      <Harness
        revealControls="hover"
        readoutPosition={{ x: 0.9, y: 0.85 }}
        readoutVisible
        clubKit={KIT}
        badgePlacement={{ x: 0.8, y: 0.12, scale: 0.12, visible: true }}
        chipHint="Drag me to move. Point at me to resize or hide."
      />
    );
    expect(chip().parentElement.className).toContain('z-10');
    expect(badge().parentElement.className).toContain('z-10');
    const larger = screen.getByRole('button', { name: 'Make the count-up larger' });
    const eye = screen.getByRole('button', { name: 'Hide the count-up from your video' });
    expect(eye.parentElement).toBe(larger.parentElement);
    expect(larger.parentElement.className).toContain('right-full');
    // The one-time hint wraps rather than running off the panel.
    expect(screen.getByRole('note').className).toContain('max-w-[11rem]');
    expect(screen.getByRole('note').className).not.toContain('whitespace-nowrap');
  });

  it("leaves today's panel as it was: no layering class, the eye on the chip's right", () => {
    render(<Harness readoutPosition={{ x: 0.9, y: 0.85 }} readoutVisible />);
    expect(chip().parentElement.className).not.toContain('z-10');
    expect(screen.getByRole('button', { name: 'Hide the count-up from your video' }).parentElement.className).toContain('left-full');
  });

  it('in design B, the chip and its buttons are near-opaque; today\'s panel keeps them translucent', () => {
    // 2026-11-17 Zoom rerun: over the card's status line, its text showed
    // through the chip and the − / + / eye.
    const props = { readoutPosition: { x: 0.5, y: 0.85 }, readoutVisible: true };
    const { unmount } = render(<Harness {...props} revealControls="hover" />);
    for (const el of [chip(), screen.getByRole('button', { name: 'Make the count-up larger' })]) {
      expect(el.className).toContain('bg-gray-900/90');
      expect(el.className).not.toContain('bg-black/35');
    }
    unmount();
    render(<Harness {...props} />);
    expect(chip().className).toContain('bg-black/35');
    expect(screen.getByRole('button', { name: 'Make the count-up larger' }).className).toContain('bg-black/35');
  });

  describe('the badge near the edges', () => {
    // jsdom lays nothing out: give the badge a 120×30 box in a 400×225 layer.
    const isAnchor = (el) => el.dataset?.testid === 'club-badge-anchor';
    const isLayer = (el) => el.firstElementChild?.dataset?.testid === 'club-badge-anchor';
    const sizes = {
      offsetWidth: (el) => (isAnchor(el) ? 120 : 0),
      offsetHeight: (el) => (isAnchor(el) ? 30 : 0),
      clientWidth: (el) => (isLayer(el) ? 400 : 0),
      clientHeight: (el) => (isLayer(el) ? 225 : 0),
    };
    // Own descriptors on HTMLElement.prototype (offset*); undefined where jsdom
    // keeps the getter on Element.prototype (client*), so deleting restores it.
    const saved = {};
    beforeAll(() => {
      for (const [prop, size] of Object.entries(sizes)) {
        saved[prop] = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop);
        Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get() { return size(this); } });
      }
    });
    afterAll(() => {
      for (const prop of Object.keys(sizes)) {
        if (saved[prop]) Object.defineProperty(HTMLElement.prototype, prop, saved[prop]);
        else delete HTMLElement.prototype[prop];
      }
    });
    const anchor = () => screen.getByTestId('club-badge-anchor');

    it('in design B, keeps it inside the frame as the video does, at its full width', () => {
      // 2026-11-17 Zoom rerun: dragged to the far left, the badge ran past the
      // card; at the top right its name was cut short.
      const { rerender } = render(
        <Harness revealControls="hover" clubKit={KIT} badgePlacement={{ x: 0.02, y: 0.98, scale: 0.12, visible: true }} />
      );
      // The video's 4% inset of the frame's height (9px of 225), plus half the badge.
      expect(parseFloat(anchor().style.left)).toBeCloseTo(((9 + 60) / 400) * 100, 3);
      expect(parseFloat(anchor().style.top)).toBeCloseTo((1 - (9 + 15) / 225) * 100, 3);
      expect(anchor().style.width).toBe('max-content');

      rerender(<Harness revealControls="hover" clubKit={KIT} badgePlacement={{ x: 0.99, y: 0.01, scale: 0.12, visible: true }} />);
      expect(parseFloat(anchor().style.left)).toBeCloseTo((1 - (9 + 60) / 400) * 100, 3);
      expect(parseFloat(anchor().style.top)).toBeCloseTo(((9 + 15) / 225) * 100, 3);

      rerender(<Harness revealControls="hover" clubKit={KIT} badgePlacement={{ x: 0.5, y: 0.5, scale: 0.12, visible: true }} />);
      expect(anchor().style.left).toBe('50%');
    });

    it("leaves today's panel placing it on the stored point", () => {
      render(<Harness clubKit={KIT} badgePlacement={{ x: 0.02, y: 0.98, scale: 0.12, visible: true }} />);
      expect(anchor().style.left).toBe('2%');
      expect(anchor().style.top).toBe('98%');
      expect(anchor().style.width).toBe('');
    });
  });

  it('draws no badge without a club kit', () => {
    render(<Harness clubKit={null} badgePlacement={{ x: 0.8, y: 0.12, scale: 0.12, visible: true }} />);
    expect(screen.queryByRole('button', { name: /club's badge/ })).not.toBeInTheDocument();
  });
});
