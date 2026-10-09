/**
 * The club's badge, as a DOM element.
 *
 * The canvas version in `packages/shared/clubBadge.js` is what participants
 * actually see — it is composited into the frame that crosses the Zoom bridge.
 * This is the same badge rendered where there is no frame to composite onto:
 * the stage (which *is* the shared surface rather than a source for one) and
 * the card preview a timer drags it around on.
 *
 * Kept deliberately proportional to the canvas routine — same top-right
 * default, same fractions of the card, same name-only fallback without a logo.
 * The two drifting apart would mean the preview lies about the meeting.
 *
 * Sizing rides `cqh`, so one `scale` drives the badge on a 280px sidebar tile
 * and on a full-screen stage alike, exactly as it does on the canvas. That
 * needs an ancestor with `container-type: size`; `ClubBadgeLayer` below is that
 * ancestor, and callers should use it rather than placing this directly.
 *
 * Stock Tailwind only; the club's colour is data, not a token, so it rides an
 * inline style. See README.md.
 */

// The canvas renderer's proportions, as multiples of the badge's own height.
const FONT_OF_HEIGHT = 0.44;
const MARK_OF_HEIGHT = 0.64;
const GAP_OF_HEIGHT = 0.22;
const PAD_OF_HEIGHT = 0.32;
const RADIUS_OF_HEIGHT = 0.24;

/**
 * The canvas renderer's 44% ceiling, re-expressed against the badge's *height*.
 *
 * `MAX_WIDTH_FRACTION` in `clubBadge.js` is 44% of the frame's *width*, and the
 * frame it draws on is the 16:9 video. Here the container is whatever the badge
 * is previewed in, and the timer tile is `aspect-square` — so the same 44% is a
 * much smaller number, and a club name that fitted on the video truncated to
 * "C…" in the preview sitting right beside it.
 *
 * In `cqh` the ceiling becomes 44% of a 16:9 frame *of this badge's own height*
 * — the frame the badge will actually land on — so every preview agrees with
 * the video. On a square tile that is ~78% of the tile's width, so it still
 * never runs off the container; every surface this badge is placed on is square
 * or wider.
 */
const MAX_WIDTH_OF_HEIGHT = ((44 * 16) / 9).toFixed(2);

/** The same fractions, re-expressed in `em` once the font size is the anchor. */
const em = (fraction) => `${(fraction / FONT_OF_HEIGHT).toFixed(3)}em`;

/**
 * A full-bleed layer to place the badge in.
 *
 * Absolutely positioned and `container-type: size`, so the badge's `cqh` units
 * resolve against the card rather than against whatever the nearest sized
 * ancestor happens to be — and so the containment it introduces lands on a div
 * that has nothing else in it.
 *
 * @param {Object} props
 * @param {import('react').ReactNode} props.children
 * @param {string} [props.className]
 */
export function ClubBadgeLayer({ children, className = '' }) {
  return (
    <div
      aria-hidden={false}
      className={`absolute inset-0 pointer-events-none ${className}`}
      style={{ containerType: 'size' }}
    >
      {children}
    </div>
  );
}

/**
 * @param {Object} props
 * @param {string} props.name - the club's name
 * @param {string} [props.primaryColor]
 * @param {string|null} [props.logoUrl]
 * @param {{x: number, y: number, scale: number, visible?: boolean}} props.placement
 *   - normalized centre and height, exactly as the canvas routine means them
 * @param {boolean} [props.positioned] - place it from `placement` (default), or
 *   leave placement to the caller, which is what the drag handle needs
 * @param {string} [props.className]
 */
export default function ClubBadge({
  name,
  primaryColor = '#772432',
  logoUrl = null,
  placement,
  positioned = true,
  className = '',
}) {
  if (!name || !placement || placement.visible === false) return null;

  const scale = Math.max(0.01, Number(placement.scale) || 0.12);
  const position = positioned
    ? {
      position: 'absolute',
      left: `${placement.x * 100}%`,
      top: `${placement.y * 100}%`,
      transform: 'translate(-50%, -50%)',
    }
    : {};

  return (
    <div
      data-testid="club-badge"
      className={`flex items-center shadow-md text-white font-bold overflow-hidden ${className}`}
      style={{
        ...position,
        // The same ceiling the canvas renderer enforces, measured the same way:
        // a long club name truncates rather than running across the artwork.
        maxWidth: `calc(${MAX_WIDTH_OF_HEIGHT} * 1cqh)`,
        height: `${scale * 100}cqh`,
        fontSize: `${scale * 100 * FONT_OF_HEIGHT}cqh`,
        borderRadius: em(RADIUS_OF_HEIGHT),
        backgroundColor: primaryColor,
        gap: logoUrl ? em(GAP_OF_HEIGHT) : 0,
        paddingLeft: em(logoUrl ? PAD_OF_HEIGHT : PAD_OF_HEIGHT + 0.1),
        paddingRight: em(PAD_OF_HEIGHT + 0.1),
      }}
    >
      {logoUrl && (
        <img
          src={logoUrl}
          alt=""
          className="bg-white object-contain flex-shrink-0"
          style={{
            height: em(MARK_OF_HEIGHT),
            width: em(MARK_OF_HEIGHT),
            borderRadius: em(RADIUS_OF_HEIGHT * 0.8),
            padding: em(0.06),
          }}
        />
      )}
      <span className="truncate leading-none">{name}</span>
    </div>
  );
}
