import { useLayoutEffect, useRef, useState } from 'react';
import { Move, Plus, Minus, Eye, EyeOff, RotateCcw } from 'lucide-react';
import ClubBadge, { ClubBadgeLayer } from '@toastmaster-timer/ui/ClubBadge';

// Written out in full, so Tailwind sees every class it has to generate.
const CHIP_REVEAL = 'opacity-0 transition-opacity group-hover/chip:opacity-100 group-focus-within/chip:opacity-100';
const BADGE_REVEAL = 'opacity-0 transition-opacity group-hover/badge:opacity-100 group-focus-within/badge:opacity-100';

// The − / + / eye / reset buttons. Today's panel keeps them translucent, as
// shipped. In design B the chip and badge can sit over the card's clock and
// status line, and that text showed through them (2026-11-17 Zoom rerun), so
// there they are near-opaque.
const CONTROL_BUTTON = {
  always: 'flex items-center justify-center h-6 w-6 rounded bg-black/35 border border-white/50 text-white hover:bg-black/50',
  hover: 'flex items-center justify-center h-6 w-6 rounded bg-gray-900/90 border border-white/50 text-white hover:bg-gray-800',
};

/**
 * A stored centre (a fraction of the frame) moved just far enough in that a
 * box `size` long stays `inset` inside both edges of an `extent`-long frame.
 * The video does this to the badge (badgeLayout in packages/shared/clubBadge.js,
 * a 4% inset); the preview does the same so it shows where the badge lands.
 */
function insetCenter(fraction, size, extent, inset) {
  if (!extent) return fraction;
  const min = (inset + size / 2) / extent;
  return Math.min(Math.max(fraction, min), Math.max(min, 1 - min));
}

/**
 * What the organizer moves around on the timer preview: the count-up chip
 * participants see on the video, and the club's badge. Each is dragged into
 * place, sized with − / + and hidden with the eye, and the move reaches Zoom
 * only on release.
 *
 * Its own component so today's square preview (TimerDisplay) and design B's
 * 16:9 card (plan 13) share one implementation of the gesture. Positions are
 * fractions of `containerRef`'s box, which is why the two shapes agree about
 * where things land on the 16:9 frame.
 *
 * Rendered inside the positioned preview box; both pieces are absolutely
 * placed within it.
 *
 * `revealControls` 'hover' (design B) keeps the − / + / eye / reset buttons
 * out of sight until the pointer is on the chip or badge, or keyboard focus is
 * inside it; 'always' (today's panel) shows them all the time. `chipHint` is a
 * short note beside the chip (it wraps at 11rem); `onChipEngaged` fires the first time the
 * pointer reaches the chip, so a caller can retire that note.
 */
export default function VideoPreviewLayer({
  containerRef,
  displayTime,
  readoutPosition,
  onReadoutPositionChange,
  readoutVisible,
  onToggleReadoutVisible,
  onAdjustReadoutScale,
  clubKit,
  badgePlacement,
  badgeMoved,
  onBadgePlacementChange,
  onAdjustBadgeScale,
  onToggleBadgeVisible,
  onResetBadgePlacement,
  revealControls = 'always',
  chipHint = null,
  onChipEngaged,
}) {
  const hover = revealControls === 'hover';
  const controlButton = hover ? CONTROL_BUTTON.hover : CONTROL_BUTTON.always;
  const [dragging, setDragging] = useState(false);
  const [draggingBadge, setDraggingBadge] = useState(false);

  // Design B only: the badge is drawn where the video will put it, kept inside
  // the frame like the video keeps it, and at its full width (bounded by its
  // own 44% ceiling). Centred on the raw point and shrink-wrapped against the
  // container's right edge, it ran out past the card on the left and cut the
  // club's name short on the right (2026-11-17 Zoom rerun, NL-10). Today's
  // panel keeps placing it as shipped.
  const insetBadge = hover && Boolean(clubKit && badgePlacement);
  const badgeRef = useRef(null);
  const [badgeBox, setBadgeBox] = useState(null);
  useLayoutEffect(() => {
    if (!insetBadge) return undefined;
    const badgeEl = badgeRef.current;
    // The frame is the badge's own layer, which fills the preview (inset-0).
    // Not containerRef: on mount a parent's ref is attached only after its
    // children's layout effects have run, so it is still empty here.
    const frame = badgeEl?.parentElement;
    if (!badgeEl || !frame) return undefined;
    const measure = () => {
      const next = {
        width: badgeEl.offsetWidth,
        height: badgeEl.offsetHeight,
        frameWidth: frame.clientWidth,
        frameHeight: frame.clientHeight,
      };
      setBadgeBox((prev) =>
        prev &&
        prev.width === next.width &&
        prev.height === next.height &&
        prev.frameWidth === next.frameWidth &&
        prev.frameHeight === next.frameHeight
          ? prev
          : next
      );
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(badgeEl);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [insetBadge, badgePlacement?.scale, clubKit?.name]);
  const badgeAt =
    insetBadge && badgeBox
      ? {
        x: insetCenter(badgePlacement.x, badgeBox.width, badgeBox.frameWidth, badgeBox.frameHeight * 0.04),
        y: insetCenter(badgePlacement.y, badgeBox.height, badgeBox.frameHeight, badgeBox.frameHeight * 0.04),
      }
      : badgePlacement;

  // This box stands in for the organizer's video tile: dragging the badge
  // within it places the count-up on the pushed background by the same
  // fraction of the frame. Normalized coordinates make the square preview and
  // the 16:9 frame agree about what "top left" means.
  const positionFromEvent = (event) => {
    const rect = containerRef.current.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
    };
  };

  const handlePointerDown = (event) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
    onChipEngaged?.();
  };

  const handlePointerMove = (event) => {
    if (!dragging) return;
    onReadoutPositionChange?.(positionFromEvent(event), { commit: false });
  };

  // Pushing the repositioned frame to Zoom costs a multi-MB bridge transfer,
  // so it happens once, on release — the badge itself follows every move.
  const handlePointerEnd = (event) => {
    if (!dragging) return;
    setDragging(false);
    onReadoutPositionChange?.(positionFromEvent(event), { commit: true });
  };

  // The badge is the same gesture on the same preview, so it is the same three
  // handlers against a second piece of state rather than a second control.
  const handleBadgePointerDown = (event) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDraggingBadge(true);
  };

  const handleBadgePointerMove = (event) => {
    if (!draggingBadge) return;
    onBadgePlacementChange?.(positionFromEvent(event), { commit: false });
  };

  const handleBadgePointerEnd = (event) => {
    if (!draggingBadge) return;
    setDraggingBadge(false);
    onBadgePlacementChange?.(positionFromEvent(event), { commit: true });
  };

  return (
    <>
      {/* The club's badge, where it will land on the video. Dragged and scaled
          with the same gesture as the count-up, and hidden independently of it:
          an organizer who switched the clock off has not asked to take their
          club's name off the card.

          The move stays on this device — the club's placement is the club's
          default, and where a badge sits relative to someone's own face is not
          something to push onto every other timer. "Reset to club position"
          puts it back. */}
      {clubKit && badgePlacement && (
        <ClubBadgeLayer>
          <div
            ref={badgeRef}
            data-testid="club-badge-anchor"
            style={{
              position: 'absolute',
              left: `${badgeAt.x * 100}%`,
              top: `${badgeAt.y * 100}%`,
              transform: 'translate(-50%, -50%)',
              width: insetBadge ? 'max-content' : undefined,
              maxWidth: '44%',
            }}
            className={hover ? 'group/badge pointer-events-auto z-10' : 'pointer-events-auto'}
          >
            <button
              type="button"
              onPointerDown={handleBadgePointerDown}
              onPointerMove={handleBadgePointerMove}
              onPointerUp={handleBadgePointerEnd}
              onPointerCancel={handleBadgePointerEnd}
              className={`block w-full touch-none select-none rounded-lg ${
                draggingBadge ? 'cursor-grabbing' : 'cursor-grab'
              } ${badgePlacement.visible ? '' : 'opacity-40'}`}
              aria-label="Drag to place your club's badge on your video"
            >
              <ClubBadge
                name={clubKit.name}
                primaryColor={clubKit.primaryColor}
                logoUrl={clubKit.logoUrl}
                placement={{ ...badgePlacement, visible: true }}
                positioned={false}
              />
            </button>
            {!draggingBadge && (
              <div
                className={
                  hover
                    ? `absolute top-full left-1/2 -translate-x-1/2 pt-1 flex items-center gap-0.5 ${BADGE_REVEAL}`
                    : 'absolute top-full left-1/2 -translate-x-1/2 mt-1 flex items-center gap-0.5'
                }
              >
                {badgePlacement.visible && (
                  <>
                    <button
                      type="button"
                      onClick={() => onAdjustBadgeScale?.(-1)}
                      className={controlButton}
                      aria-label="Make the club badge smaller"
                    >
                      <Minus className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onAdjustBadgeScale?.(1)}
                      className={controlButton}
                      aria-label="Make the club badge larger"
                    >
                      <Plus className="h-3 w-3" />
                    </button>
                  </>
                )}
                <button
                  type="button"
                  onClick={() => onToggleBadgeVisible?.()}
                  className={controlButton}
                  aria-label={
                    badgePlacement.visible
                      ? "Hide your club's badge on your video"
                      : "Show your club's badge on your video"
                  }
                >
                  {badgePlacement.visible ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                </button>
                {badgeMoved && (
                  <button
                    type="button"
                    onClick={() => onResetBadgePlacement?.()}
                    className={controlButton}
                    aria-label="Reset to club position"
                  >
                    <RotateCcw className="h-3 w-3" />
                  </button>
                )}
              </div>
            )}
          </div>
        </ClubBadgeLayer>
      )}

      {/* Where the count-up sits on the video other participants see. Only the
          video modes show it: the full-screen timer pushes no frame to drag
          anything on.

          No data-tooltip anywhere in this cluster, deliberately: the tooltip
          pseudo-element repaints above the chip while it moves under pointer
          capture, which smeared black trails across the preview.

          In design B the card's clock and status line share this box, so the
          chip and the badge sit at z-10: their buttons must stay above that
          text to take clicks. */}
      {readoutPosition && (
        <div
          // The anchor is the chip alone, so its center — not the center of
          // chip plus buttons — is what the stored position means. The chip is
          // the marker for where the readout lands on the pushed frame; the
          // buttons hang off its side out of flow, shifting nothing.
          style={{
            position: 'absolute',
            left: `${readoutPosition.x * 100}%`,
            top: `${readoutPosition.y * 100}%`,
            transform: 'translate(-50%, -50%)',
          }}
          className={hover ? 'group/chip z-10' : undefined}
          onMouseEnter={onChipEngaged}
        >
          <button
            type="button"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerEnd}
            onPointerCancel={handlePointerEnd}
            className={`flex items-center gap-1 px-2 py-1 rounded-md ${hover ? 'bg-gray-900/90' : 'bg-black/35'} border border-white/50 text-white text-sm font-mono font-semibold touch-none select-none ${
              dragging ? 'cursor-grabbing' : 'cursor-grab'
            } ${readoutVisible ? '' : 'opacity-50'}`}
            aria-label="Drag to place the count-up participants see on your video"
          >
            <Move className="h-3 w-3 opacity-80 flex-shrink-0" />
            {displayTime}
          </button>
          {/* Hidden while dragging: the chip is the only thing that should
              follow the pointer, and stray buttons under it catch the drop.
              Size controls sit to the chip's left and visibility to its right
              — unless the chip is near the left edge (where it starts, under
              the logo), in which case everything moves right rather than
              overflowing the card. Always out of flow, so nothing shifts the
              chip off its anchor. */}
          {!dragging && (() => {
            const nearLeftEdge = readoutPosition.x < 0.35;
            // Design B's preview fills the panel's width, so near its right
            // edge the eye would hang outside the panel: keep every button on
            // the chip's left there instead.
            const nearRightEdge = hover && readoutPosition.x > 0.65;
            const sizeButtons = readoutVisible && (
              <>
                <button
                  type="button"
                  onClick={() => onAdjustReadoutScale?.(-1)}
                  className={controlButton}
                  aria-label="Make the count-up smaller"
                >
                  <Minus className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  onClick={() => onAdjustReadoutScale?.(1)}
                  className={controlButton}
                  aria-label="Make the count-up larger"
                >
                  <Plus className="h-3 w-3" />
                </button>
              </>
            );
            const eyeButton = (
              <button
                type="button"
                onClick={() => onToggleReadoutVisible?.()}
                className={controlButton}
                aria-label={readoutVisible ? 'Hide the count-up from your video' : 'Show the count-up on your video'}
              >
                {readoutVisible ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
              </button>
            );
            if (nearRightEdge) {
              return (
                <div className={`absolute right-full top-1/2 -translate-y-1/2 pr-1 flex items-center gap-0.5 ${CHIP_REVEAL}`}>
                  {sizeButtons}
                  {eyeButton}
                </div>
              );
            }
            return nearLeftEdge ? (
              <div
                className={
                  hover
                    ? `absolute left-full top-1/2 -translate-y-1/2 pl-1 flex items-center gap-0.5 ${CHIP_REVEAL}`
                    : 'absolute left-full top-1/2 -translate-y-1/2 ml-1 flex items-center gap-0.5'
                }
              >
                {sizeButtons}
                {eyeButton}
              </div>
            ) : (
              <>
                {readoutVisible && (
                  <div
                    className={
                      hover
                        ? `absolute right-full top-1/2 -translate-y-1/2 pr-1 flex items-center gap-0.5 ${CHIP_REVEAL}`
                        : 'absolute right-full top-1/2 -translate-y-1/2 mr-1 flex items-center gap-0.5'
                    }
                  >
                    {sizeButtons}
                  </div>
                )}
                <div
                  className={
                    hover
                      ? `absolute left-full top-1/2 -translate-y-1/2 pl-1 flex items-center ${CHIP_REVEAL}`
                      : 'absolute left-full top-1/2 -translate-y-1/2 ml-1 flex items-center'
                  }
                >
                  {eyeButton}
                </div>
              </>
            );
          })()}
          {chipHint && !dragging && (
            <span
              role="note"
              className={`pointer-events-none absolute w-max max-w-[11rem] rounded-md bg-gray-900 px-2 py-1.5 text-[11px] leading-snug text-white shadow-lg ${
                readoutPosition.y > 0.5 ? 'bottom-full mb-1.5' : 'top-full mt-1.5'
              } ${readoutPosition.x > 0.6 ? 'right-0' : 'left-0'}`}
            >
              {chipHint}
            </span>
          )}
        </div>
      )}
    </>
  );
}
