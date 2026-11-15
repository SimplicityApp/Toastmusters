import { useState } from 'react';
import { Move, Plus, Minus, Eye, EyeOff, RotateCcw } from 'lucide-react';
import ClubBadge, { ClubBadgeLayer } from '@toastmaster-timer/ui/ClubBadge';

// Written out in full, so Tailwind sees every class it has to generate.
const CHIP_REVEAL = 'opacity-0 transition-opacity group-hover/chip:opacity-100 group-focus-within/chip:opacity-100';
const BADGE_REVEAL = 'opacity-0 transition-opacity group-hover/badge:opacity-100 group-focus-within/badge:opacity-100';

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
 * one-line note under the chip; `onChipEngaged` fires the first time the
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
  const [dragging, setDragging] = useState(false);
  const [draggingBadge, setDraggingBadge] = useState(false);

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
            style={{
              position: 'absolute',
              left: `${badgePlacement.x * 100}%`,
              top: `${badgePlacement.y * 100}%`,
              transform: 'translate(-50%, -50%)',
              maxWidth: '44%',
            }}
            className={hover ? 'group/badge pointer-events-auto' : 'pointer-events-auto'}
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
                      className="flex items-center justify-center h-6 w-6 rounded bg-black/35 border border-white/50 text-white hover:bg-black/50"
                      aria-label="Make the club badge smaller"
                    >
                      <Minus className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onAdjustBadgeScale?.(1)}
                      className="flex items-center justify-center h-6 w-6 rounded bg-black/35 border border-white/50 text-white hover:bg-black/50"
                      aria-label="Make the club badge larger"
                    >
                      <Plus className="h-3 w-3" />
                    </button>
                  </>
                )}
                <button
                  type="button"
                  onClick={() => onToggleBadgeVisible?.()}
                  className="flex items-center justify-center h-6 w-6 rounded bg-black/35 border border-white/50 text-white hover:bg-black/50"
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
                    className="flex items-center justify-center h-6 w-6 rounded bg-black/35 border border-white/50 text-white hover:bg-black/50"
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
          capture, which smeared black trails across the preview. */}
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
          className={hover ? 'group/chip' : undefined}
          onMouseEnter={onChipEngaged}
        >
          <button
            type="button"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerEnd}
            onPointerCancel={handlePointerEnd}
            className={`flex items-center gap-1 px-2 py-1 rounded-md bg-black/35 border border-white/50 text-white text-sm font-mono font-semibold touch-none select-none ${
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
            const sizeButtons = readoutVisible && (
              <>
                <button
                  type="button"
                  onClick={() => onAdjustReadoutScale?.(-1)}
                  className="flex items-center justify-center h-6 w-6 rounded bg-black/35 border border-white/50 text-white hover:bg-black/50"
                  aria-label="Make the count-up smaller"
                >
                  <Minus className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  onClick={() => onAdjustReadoutScale?.(1)}
                  className="flex items-center justify-center h-6 w-6 rounded bg-black/35 border border-white/50 text-white hover:bg-black/50"
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
                className="flex items-center justify-center h-6 w-6 rounded bg-black/35 border border-white/50 text-white hover:bg-black/50"
                aria-label={readoutVisible ? 'Hide the count-up from your video' : 'Show the count-up on your video'}
              >
                {readoutVisible ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
              </button>
            );
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
              className={`pointer-events-none absolute whitespace-nowrap rounded-md bg-gray-900 px-2 py-1.5 text-[11px] leading-snug text-white shadow-lg ${
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
