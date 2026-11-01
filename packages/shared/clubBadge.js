/**
 * The club's badge, drawn onto a 2D canvas.
 *
 * Framework-free and DOM-free on purpose: this runs inside the Zoom app's
 * compositing path, where the frame is an ImageData being assembled for the
 * bridge, and there is no document to lay anything out in. It is the same
 * technique `drawTimeReadout` already uses, and it is testable the same way —
 * against a stubbed 2D context, with no browser and no image fixtures.
 *
 * The badge deliberately never touches the *background*. Built-in cards are
 * pushed as `setVirtualBackground({ fileUrl })` with no pixels crossing the
 * bridge at all, and that fast path is what holds card switching inside the
 * 25 ms warm budget. So the badge goes where the time readout already goes: the
 * virtual-foreground layer in camera mode, the filter frame in card mode, and a
 * DOM element in stage mode.
 */

/** Toastmasters maroon. The kit's colour when a club has not chosen one. */
export const DEFAULT_PRIMARY_COLOR = '#772432';

/**
 * Top-right, mirroring where the Toastmasters International logo sits on the
 * other side of the card. It is also the only corner that survives camera mode,
 * where the organizer's body covers the centre and the bottom of the frame.
 *
 * `x`/`y` are the normalized centre of the badge, exactly as
 * `toastmaster_overlay_time_readout` means them, so the drag handle is a second
 * instance of the readout's control rather than a new one.
 */
export const DEFAULT_BADGE_PLACEMENT = Object.freeze({ x: 0.8, y: 0.12, scale: 0.12, visible: true });

/** Badge height as a fraction of the frame, clamped the way the readout is. */
export const BADGE_SCALE_MIN = 0.06;
export const BADGE_SCALE_MAX = 0.28;

/**
 * The badge never grows past its corner, however long the club's name is —
 * a "Greater Vancouver Advanced Communicators Club" that ran the width of the
 * card would be covering the thing the card exists to show.
 */
const MAX_WIDTH_FRACTION = 0.44;

const ELLIPSIS = '…';

/** @param {number} scale @returns {number} */
export function clampBadgeScale(scale) {
  const value = Number(scale);
  if (!Number.isFinite(value)) return DEFAULT_BADGE_PLACEMENT.scale;
  return Math.min(BADGE_SCALE_MAX, Math.max(BADGE_SCALE_MIN, value));
}

const clamp01 = (value, fallback) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(1, Math.max(0, number));
};

/**
 * Fold whatever was stored (or published) into a placement the renderer can use
 * without re-checking every field.
 *
 * @param {Object} [placement]
 * @param {Object} [base] - what an absent field falls back to
 * @returns {{x: number, y: number, scale: number, visible: boolean}}
 */
export function normalizeBadgePlacement(placement, base = DEFAULT_BADGE_PLACEMENT) {
  return {
    x: clamp01(placement?.x, base.x ?? DEFAULT_BADGE_PLACEMENT.x),
    y: clamp01(placement?.y, base.y ?? DEFAULT_BADGE_PLACEMENT.y),
    scale: clampBadgeScale(placement?.scale ?? base.scale ?? DEFAULT_BADGE_PLACEMENT.scale),
    visible:
      typeof placement?.visible === 'boolean'
        ? placement.visible
        : typeof base?.visible === 'boolean'
          ? base.visible
          : true,
  };
}

/**
 * Trim a name to fit, with an ellipsis, measured against the context that will
 * draw it. Linear from the end rather than a binary search: club names are a
 * handful of words, and `measureText` on a stubbed context has to stay cheap.
 *
 * @param {CanvasRenderingContext2D} ctx - font already set
 * @param {string} text
 * @param {number} maxWidth
 * @returns {string}
 */
export function ellipsizeText(ctx, text, maxWidth) {
  const full = String(text ?? '');
  if (maxWidth <= 0) return '';
  if (ctx.measureText(full).width <= maxWidth) return full;

  let trimmed = full;
  while (trimmed.length > 0 && ctx.measureText(trimmed + ELLIPSIS).width > maxWidth) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed ? trimmed.trimEnd() + ELLIPSIS : '';
}

/**
 * A rounded rectangle as an explicit path.
 *
 * Hand-rolled rather than `ctx.roundRect`, which is recent enough that the Zoom
 * webview on an older client may not have it — and a badge that throws would
 * take the colour signal down with it.
 */
function roundedRectPath(ctx, x, y, width, height, radius) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/**
 * Everything about a badge that does not need a context: whether there is one
 * to draw at all, and the sizes that follow from its height. Null when nothing
 * would be drawn, checked before any context call so that "no badge" stays
 * zero draw calls.
 */
function badgeSpec(width, height, kit, placement) {
  if (!width || !height) return null;
  if (!kit || kit.showOnCards === false) return null;

  const name = String(kit.name ?? '').trim();
  const logo = kit.logo ?? null;
  if (!name && !logo) return null;

  const place = normalizeBadgePlacement(placement);
  if (!place.visible) return null;

  const badgeHeight = Math.max(12, Math.round(height * place.scale));
  const fontSize = Math.round(badgeHeight * 0.44);
  return {
    name,
    logo,
    place,
    badgeHeight,
    font: `bold ${fontSize}px 'Helvetica Neue', Helvetica, Arial, sans-serif`,
    padX: Math.round(badgeHeight * 0.32),
    gap: logo ? Math.round(badgeHeight * 0.22) : 0,
    markSize: logo ? Math.round(badgeHeight * 0.64) : 0,
  };
}

/**
 * Where the badge sits on the frame. Measures the name, so `ctx.font` must
 * already be `spec.font`.
 */
function badgeLayout(ctx, width, height, spec) {
  const { name, logo, place, badgeHeight, padX, gap, markSize } = spec;
  const chrome = padX * 2 + (logo ? markSize + gap : 0);
  const maxWidth = Math.max(markSize + chrome, Math.round(width * MAX_WIDTH_FRACTION));
  const label = name ? ellipsizeText(ctx, name, maxWidth - chrome) : '';
  const labelWidth = label ? ctx.measureText(label).width : 0;
  const badgeWidth = Math.round(chrome + labelWidth - (label ? 0 : gap));

  // The same 4% inset the readout uses, so the two never sit at different
  // distances from the same edge.
  const pad = Math.round(height * 0.04);
  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
  const cx = Math.round(clamp(place.x * width, pad + badgeWidth / 2, Math.max(pad + badgeWidth / 2, width - pad - badgeWidth / 2)));
  const cy = Math.round(clamp(place.y * height, pad + badgeHeight / 2, Math.max(pad + badgeHeight / 2, height - pad - badgeHeight / 2)));
  return {
    label,
    cy,
    left: Math.round(cx - badgeWidth / 2),
    top: Math.round(cy - badgeHeight / 2),
    badgeWidth,
  };
}

/**
 * The rectangle the badge would occupy, without drawing anything.
 *
 * The camera-mode foreground is cropped to the box that holds the readout and
 * the badge, and the crop has to be known before the canvas is sized — resizing
 * a canvas clears it. Same arguments and same answer as `drawClubBadge`. The
 * context's font is set only between a save and a restore, so the caller's
 * drawing state is untouched.
 *
 * @param {CanvasRenderingContext2D} ctx - used only to measure the name
 * @param {number} width - frame width in pixels
 * @param {number} height - frame height in pixels
 * @param {Object|null} kit - as for drawClubBadge
 * @param {Object} [placement] - as for drawClubBadge
 * @returns {{x: number, y: number, width: number, height: number}|null} the
 *   rectangle, not counting the 1-2 px drop shadow, or null when nothing would
 *   be drawn
 */
export function clubBadgeRect(ctx, width, height, kit, placement) {
  if (!ctx) return null;
  const spec = badgeSpec(width, height, kit, placement);
  if (!spec) return null;

  ctx.save();
  try {
    ctx.font = spec.font;
    const { left, top, badgeWidth } = badgeLayout(ctx, width, height, spec);
    return { x: left, y: top, width: badgeWidth, height: spec.badgeHeight };
  } finally {
    ctx.restore();
  }
}

/**
 * Draw the club's badge onto a frame.
 *
 * Issues no draw calls at all when there is nothing to draw — no kit, the club
 * turned "Show on cards" off, or this device hid the badge — so a card with the
 * badge suppressed is pixel-identical to one rendered before any of this
 * existed.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} width - frame width in pixels
 * @param {number} height - frame height in pixels
 * @param {{name?: string, logo?: CanvasImageSource|null, primaryColor?: string,
 *   showOnCards?: boolean}|null} kit
 * @param {{x?: number, y?: number, scale?: number, visible?: boolean}} [placement]
 * @returns {{x: number, y: number, width: number, height: number}|null} the
 *   rectangle the badge occupies, or null when nothing was drawn
 */
export function drawClubBadge(ctx, width, height, kit, placement) {
  if (!ctx) return null;
  const spec = badgeSpec(width, height, kit, placement);
  if (!spec) return null;
  const { logo, badgeHeight, padX, gap, markSize } = spec;

  ctx.save();
  try {
    ctx.font = spec.font;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    const { label, cy, left, top, badgeWidth } = badgeLayout(ctx, width, height, spec);

    // A drop shadow rather than a keyline: the badge lands on whatever card art
    // the club uploaded, and a fixed outline colour cannot be right on all of
    // them.
    ctx.fillStyle = 'rgba(0, 0, 0, 0.28)';
    roundedRectPath(ctx, left + 1, top + 2, badgeWidth, badgeHeight, Math.round(badgeHeight * 0.24));
    ctx.fill();

    ctx.fillStyle = kit.primaryColor || DEFAULT_PRIMARY_COLOR;
    roundedRectPath(ctx, left, top, badgeWidth, badgeHeight, Math.round(badgeHeight * 0.24));
    ctx.fill();

    if (logo) {
      const markLeft = left + padX;
      const markTop = Math.round(cy - markSize / 2);
      // A white tile under the mark: club logos are recommended as transparent
      // PNGs, and a dark one on a dark primary colour would disappear.
      ctx.fillStyle = '#ffffff';
      roundedRectPath(ctx, markLeft, markTop, markSize, markSize, Math.round(markSize * 0.24));
      ctx.fill();
      const inset = Math.round(markSize * 0.12);
      ctx.drawImage(logo, markLeft + inset, markTop + inset, markSize - inset * 2, markSize - inset * 2);
    }

    if (label) {
      ctx.fillStyle = '#ffffff';
      ctx.fillText(label, left + padX + (logo ? markSize + gap : 0), cy);
    }

    return { x: left, y: top, width: badgeWidth, height: badgeHeight };
  } finally {
    ctx.restore();
  }
}

/**
 * Whether two badge states would draw the same pixels.
 *
 * This is the function the dirty-check in `syncForegroundReadout` turns on.
 * That check exists to skip redundant bridge pushes and compares only the
 * readout's own fields, so without the badge in it a badge that moves while the
 * label is unchanged compares equal and never repaints — the badge would look
 * right on the preview tile and do nothing at all in the meeting.
 *
 * @param {Object|null} a
 * @param {Object|null} b
 * @returns {boolean}
 */
export function badgeUnchanged(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return (
    a.kit?.name === b.kit?.name &&
    a.kit?.logo === b.kit?.logo &&
    a.kit?.primaryColor === b.kit?.primaryColor &&
    a.kit?.showOnCards === b.kit?.showOnCards &&
    a.placement?.x === b.placement?.x &&
    a.placement?.y === b.placement?.y &&
    a.placement?.scale === b.placement?.scale &&
    a.placement?.visible === b.placement?.visible
  );
}
