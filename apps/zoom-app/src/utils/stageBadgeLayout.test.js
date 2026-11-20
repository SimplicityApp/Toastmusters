import { describe, it, expect } from 'vitest';
import { DEFAULT_BADGE_PLACEMENT } from '@toastmaster-timer/shared';
import { cardBand, stageBadgeLayout } from './stageBadgeLayout';

// The stage as the real Zoom client showed it on 2026-11-16: the sidebar panel,
// ~400px wide and much taller, with the speaker row and Screenshare at the top
// and the clock and START at the bottom.
const PANEL = { width: 400, height: 800, topInset: 116, bottomInset: 110 };
// A popped-out window at 16:9: the card fills it, and the controls sit on the card.
const WIDE = { width: 1280, height: 720, topInset: 116, bottomInset: 110 };

/** The badge as ClubBadge renders it on a card of this height: `scale` of it. */
const badgeOn = (band, width, scale = DEFAULT_BADGE_PLACEMENT.scale) => ({ width, height: band.height * scale });

/** The badge's box in stage pixels. */
const onStage = (layout, badge) => ({
  left: layout.band.left + layout.centre.x - badge.width / 2,
  right: layout.band.left + layout.centre.x + badge.width / 2,
  top: layout.band.top + layout.centre.y - badge.height / 2,
  bottom: layout.band.top + layout.centre.y + badge.height / 2,
});

describe('cardBand', () => {
  it('is a 16:9 band across the middle of a tall panel, like the contained artwork', () => {
    expect(cardBand(400, 800)).toEqual({ left: 0, top: 287.5, width: 400, height: 225 });
  });

  it('is the whole stage at 16:9, and centred with margins on a wider one', () => {
    expect(cardBand(1280, 720)).toEqual({ left: 0, top: 0, width: 1280, height: 720 });
    const wider = cardBand(1600, 720);
    expect(wider.height).toBe(720);
    expect(wider.width).toBeCloseTo(1280);
    expect(wider.left).toBeCloseTo(160);
  });

  it('is null for a stage with no size yet', () => {
    expect(cardBand(0, 800)).toBeNull();
    expect(cardBand(400, 0)).toBeNull();
    expect(cardBand(undefined, undefined)).toBeNull();
  });
});

describe('stageBadgeLayout', () => {
  it('sizes the badge against the card on a narrow panel, not against the panel', () => {
    const { band } = stageBadgeLayout(PANEL, null, DEFAULT_BADGE_PLACEMENT);
    // 12% of the 225px card, as on the video: 27px. Against the 800px panel it
    // was 96px, which is what put a "Claude Test Club" badge over half the panel.
    expect(badgeOn(band, 1).height).toBe(27);
    expect(band.height * DEFAULT_BADGE_PLACEMENT.scale).toBeLessThan(PANEL.height * DEFAULT_BADGE_PLACEMENT.scale / 3);
  });

  it('puts the default badge where the video does, clear of the controls', () => {
    const band = cardBand(PANEL.width, PANEL.height);
    // 28% of the card's width, as the same badge measured on the 16:9 video.
    const badge = badgeOn(band, 0.28 * band.width);
    const layout = stageBadgeLayout(PANEL, badge, DEFAULT_BADGE_PLACEMENT);

    expect(layout.centre).toEqual({ x: 320, y: 27 });
    const box = onStage(layout, badge);
    expect(box.right).toBeLessThanOrEqual(PANEL.width);
    expect(box.top).toBeGreaterThan(PANEL.topInset);
    expect(box.bottom).toBeLessThan(PANEL.height - PANEL.bottomInset);
  });

  it('keeps a long name on the card, by the video\'s inset', () => {
    const band = cardBand(PANEL.width, PANEL.height);
    // The 44% ceiling: wide enough that the 0.8 centre would run off the right.
    const badge = badgeOn(band, 0.44 * band.width);
    const layout = stageBadgeLayout(PANEL, badge, DEFAULT_BADGE_PLACEMENT);

    const inset = Math.round(band.height * 0.04);
    expect(onStage(layout, badge).right).toBeLessThanOrEqual(PANEL.width - inset);
  });

  it('keeps a badge dragged into a corner on the card', () => {
    const band = cardBand(PANEL.width, PANEL.height);
    const badge = badgeOn(band, 112);

    const corner = onStage(stageBadgeLayout(PANEL, badge, { x: 1, y: 1, scale: 0.12 }), badge);
    expect(corner.right).toBeLessThanOrEqual(band.left + band.width);
    expect(corner.bottom).toBeLessThanOrEqual(band.top + band.height);

    const origin = onStage(stageBadgeLayout(PANEL, badge, { x: 0, y: 0, scale: 0.12 }), badge);
    expect(origin.left).toBeGreaterThanOrEqual(band.left);
    expect(origin.top).toBeGreaterThanOrEqual(band.top);
  });

  it('moves the badge out from under the controls when the card reaches under them', () => {
    const band = cardBand(WIDE.width, WIDE.height);
    const badge = badgeOn(band, 0.28 * band.width);
    const layout = stageBadgeLayout(WIDE, badge, DEFAULT_BADGE_PLACEMENT);

    const box = onStage(layout, badge);
    expect(box.top).toBeGreaterThan(WIDE.topInset);
    // Only moved down: the size and the x are still the video's.
    expect(layout.centre.x).toBe(Math.round(0.8 * band.width));
    expect(badge.height).toBeCloseTo(0.12 * 720);

    const low = onStage(stageBadgeLayout(WIDE, badge, { x: 0.5, y: 1, scale: 0.12 }), badge);
    expect(low.bottom).toBeLessThan(WIDE.height - WIDE.bottomInset);
  });

  it('leaves the badge off when there is no room between the controls', () => {
    const short = { width: 400, height: 250, topInset: 116, bottomInset: 110 };
    const band = cardBand(short.width, short.height);
    const layout = stageBadgeLayout(short, badgeOn(band, 100), DEFAULT_BADGE_PLACEMENT);
    expect(layout.band).toEqual(band);
    expect(layout.centre).toBeNull();
  });

  it('has a band but no centre until the badge has been measured', () => {
    const layout = stageBadgeLayout(PANEL, { width: 0, height: 0 }, DEFAULT_BADGE_PLACEMENT);
    expect(layout.band).toEqual(cardBand(400, 800));
    expect(layout.centre).toBeNull();
    expect(stageBadgeLayout(PANEL, null, DEFAULT_BADGE_PLACEMENT).centre).toBeNull();
  });

  it('is null before the stage has a size', () => {
    expect(stageBadgeLayout({ width: 0, height: 0 }, { width: 100, height: 27 }, DEFAULT_BADGE_PLACEMENT)).toBeNull();
    expect(stageBadgeLayout(null, null, DEFAULT_BADGE_PLACEMENT)).toBeNull();
  });

  it('falls back to the default placement for a sparse one', () => {
    const band = cardBand(PANEL.width, PANEL.height);
    const badge = badgeOn(band, 112);
    expect(stageBadgeLayout(PANEL, badge, { scale: 0.12 }).centre).toEqual(
      stageBadgeLayout(PANEL, badge, DEFAULT_BADGE_PLACEMENT).centre
    );
  });
});
