import { badgeCentre, normalizeBadgePlacement } from '@toastmaster-timer/shared';

/** The cards are 16:9: the video frame, and the artwork the stage shows. */
const CARD_ASPECT = 16 / 9;

/** The gap the badge keeps from the stage controls, as a share of the card's height. */
const CONTROLS_GAP_OF_HEIGHT = 0.04;

/**
 * The 16:9 card the stage's artwork occupies.
 *
 * The stage paints the card with `background-size: contain`, centred, so on the
 * tall, narrow sidebar panel the card is a band across the middle and the rest
 * is blurred backdrop. The badge belongs to the card, not to the panel: on the
 * video its height is a share of the 16:9 frame, so on the stage it has to be a
 * share of this band, or a 0.12 badge on an 800px-tall panel comes out 96px
 * high, wider than half the panel, and over the stage controls.
 *
 * @param {number} width - stage width in pixels
 * @param {number} height - stage height in pixels
 * @returns {{left: number, top: number, width: number, height: number}|null}
 */
export function cardBand(width, height) {
  if (!(width > 0) || !(height > 0)) return null;
  const bandWidth = Math.min(width, height * CARD_ASPECT);
  const bandHeight = bandWidth / CARD_ASPECT;
  return {
    left: (width - bandWidth) / 2,
    top: (height - bandHeight) / 2,
    width: bandWidth,
    height: bandHeight,
  };
}

/**
 * Where the club badge goes on the stage.
 *
 * On the card band, by the same rule the video uses (`badgeCentre`): the
 * placement scaled to the card, then pulled in so the whole badge stays on it.
 * Then kept clear of the stage controls. They run the full width of the stage,
 * so only the vertical position can collide with them, and only when the card
 * reaches under them, as it does in a wide popped-out window. There the badge
 * moves down (or up) just far enough; its size and its x stay the video's.
 *
 * @param {{width: number, height: number, topInset?: number, bottomInset?: number}} stage
 *   - the stage's size, and how far the top and bottom controls reach into it, in pixels
 * @param {{width: number, height: number}|null} badge - the rendered badge's size in
 *   pixels, or null before it has been measured
 * @param {{x: number, y: number}} placement - normalized centre, as on the video
 * @returns {{band: {left: number, top: number, width: number, height: number},
 *   centre: {x: number, y: number}|null}|null} null without a stage to measure;
 *   `centre` is relative to the band, and null when the badge is not measured yet
 *   or there is no room for it between the controls
 */
export function stageBadgeLayout(stage, badge, placement) {
  const band = cardBand(stage?.width, stage?.height);
  if (!band) return null;
  if (!placement || !(badge?.width > 0) || !(badge?.height > 0)) return { band, centre: null };

  const place = normalizeBadgePlacement(placement);
  const { cx, cy } = badgeCentre(band.width, band.height, place, badge.width, badge.height);

  const gap = band.height * CONTROLS_GAP_OF_HEIGHT;
  const highest = (stage.topInset ?? 0) + gap + badge.height / 2 - band.top;
  const lowest = stage.height - (stage.bottomInset ?? 0) - gap - badge.height / 2 - band.top;
  // A window too short to fit the badge between the controls: leave it off
  // rather than over the buttons the organizer runs the meeting with.
  if (highest > lowest) return { band, centre: null };

  return { band, centre: { x: cx, y: Math.min(Math.max(cy, highest), lowest) } };
}
