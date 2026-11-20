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

  it('draws no badge without a club kit', () => {
    render(<Harness clubKit={null} badgePlacement={{ x: 0.8, y: 0.12, scale: 0.12, visible: true }} />);
    expect(screen.queryByRole('button', { name: /club's badge/ })).not.toBeInTheDocument();
  });
});
