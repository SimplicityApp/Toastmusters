import { describe, it, expect, beforeEach } from 'vitest';
import {
  drawClubBadge,
  clubBadgeRect,
  badgeUnchanged,
  normalizeBadgePlacement,
  clampBadgeScale,
  ellipsizeText,
  DEFAULT_BADGE_PLACEMENT,
  DEFAULT_PRIMARY_COLOR,
  BADGE_SCALE_MIN,
  BADGE_SCALE_MAX,
} from '../clubBadge.js';
import {
  CLUB_STORAGE_KEY,
  CLUB_BADGE_STORAGE_KEY,
  clubKit,
  clubBadgePlacement,
  clubBadgeDefault,
  clubBadgeState,
  saveClubBadgeOverride,
  clearClubBadgeOverride,
  hasClubBadgeOverride,
  warmClubLogo,
  getClubLogoImage,
  leaveClub,
  resetClubForTests,
} from '../club.js';

/**
 * The badge as pixels, and the badge as state.
 *
 * Drawn against a stubbed 2D context rather than a real canvas, the same way
 * zoomSdk.test.js asserts on drawTimeReadout: no browser, no image fixtures,
 * and every draw call visible in order.
 */

/** A 2D context that records everything asked of it. */
function stubContext({ charWidth = 10 } = {}) {
  const ops = [];
  const ctx = {
    font: '',
    textAlign: '',
    textBaseline: '',
    fillStyle: '',
    save: () => ops.push(['save']),
    restore: () => ops.push(['restore']),
    beginPath: () => ops.push(['beginPath']),
    closePath: () => ops.push(['closePath']),
    moveTo: (...a) => ops.push(['moveTo', ...a]),
    lineTo: (...a) => ops.push(['lineTo', ...a]),
    quadraticCurveTo: (...a) => ops.push(['quadraticCurveTo', ...a]),
    fill: () => ops.push(['fill', ctx.fillStyle]),
    drawImage: (image, x, y, w, h) => ops.push(['drawImage', image, x, y, w, h]),
    fillText: (text, x, y) => ops.push(['fillText', text, x, y, ctx.fillStyle]),
    measureText: (text) => ({ width: String(text).length * charWidth }),
  };
  return { ctx, ops };
}

const textOf = (ops) => ops.filter(([op]) => op === 'fillText').map(([, text]) => text);
const fills = (ops) => ops.filter(([op]) => op === 'fill').map(([, color]) => color);

const FRAME = { width: 1280, height: 720 };
const KIT = { name: 'Downtown Speakers', primaryColor: '#772432', showOnCards: true, logo: null };
const PLACE = { x: 0.8, y: 0.12, scale: 0.12, visible: true };

beforeEach(() => {
  localStorage.clear();
  resetClubForTests();
});

describe('drawClubBadge', () => {
  it('draws the name in the club colour when there is no logo', () => {
    const { ctx, ops } = stubContext();

    const rect = drawClubBadge(ctx, FRAME.width, FRAME.height, KIT, PLACE);

    expect(textOf(ops)).toEqual(['Downtown Speakers']);
    // The shadow first, then the pill in the club's own colour.
    expect(fills(ops)).toContain('#772432');
    // Name-only means no mark at all, not an empty white tile.
    expect(ops.some(([op]) => op === 'drawImage')).toBe(false);
    expect(rect.height).toBe(Math.round(FRAME.height * 0.12));
  });

  it('draws the logo beside the name when one has been decoded', () => {
    const { ctx, ops } = stubContext();
    const logo = { nodeName: 'IMG' };

    drawClubBadge(ctx, FRAME.width, FRAME.height, { ...KIT, logo }, PLACE);

    const drawn = ops.find(([op]) => op === 'drawImage');
    expect(drawn).toBeTruthy();
    expect(drawn[1]).toBe(logo);
    expect(textOf(ops)).toEqual(['Downtown Speakers']);
    // A white tile under the mark, so a transparent PNG is visible on a dark
    // primary colour.
    expect(fills(ops)).toContain('#ffffff');
  });

  it('issues no draw calls at all when the club turned "Show on cards" off', () => {
    const { ctx, ops } = stubContext();

    // Pixel-identical to a card rendered before any of this existed — which is
    // the whole promise of the toggle.
    expect(drawClubBadge(ctx, FRAME.width, FRAME.height, { ...KIT, showOnCards: false }, PLACE)).toBeNull();
    expect(ops).toHaveLength(0);
  });

  it('issues no draw calls when this device hid the badge, or there is no club', () => {
    const { ctx, ops } = stubContext();

    expect(drawClubBadge(ctx, FRAME.width, FRAME.height, KIT, { ...PLACE, visible: false })).toBeNull();
    expect(drawClubBadge(ctx, FRAME.width, FRAME.height, null, PLACE)).toBeNull();
    expect(drawClubBadge(ctx, FRAME.width, FRAME.height, { ...KIT, name: '  ' }, PLACE)).toBeNull();
    expect(ops).toHaveLength(0);
  });

  it('ellipsizes a long name and never grows past its corner', () => {
    // Wide glyphs, so the name is past the ceiling rather than merely long.
    const { ctx, ops } = stubContext({ charWidth: 40 });
    const long = 'Greater Vancouver Advanced Communicators Club';

    const rect = drawClubBadge(ctx, FRAME.width, FRAME.height, { ...KIT, name: long }, PLACE);

    const [drawn] = textOf(ops);
    expect(drawn).not.toBe(long);
    expect(drawn.endsWith('…')).toBe(true);
    // 44% of the frame is the ceiling; a name that ran the width of the card
    // would be covering the thing the card exists to show.
    expect(rect.width).toBeLessThanOrEqual(Math.round(FRAME.width * 0.44));
  });

  it('keeps the whole badge on the frame however far it is dragged', () => {
    const { ctx } = stubContext();

    const corner = drawClubBadge(ctx, FRAME.width, FRAME.height, KIT, { ...PLACE, x: 1, y: 1 });
    expect(corner.x + corner.width).toBeLessThanOrEqual(FRAME.width);
    expect(corner.y + corner.height).toBeLessThanOrEqual(FRAME.height);

    const origin = drawClubBadge(ctx, FRAME.width, FRAME.height, KIT, { ...PLACE, x: 0, y: 0 });
    expect(origin.x).toBeGreaterThanOrEqual(0);
    expect(origin.y).toBeGreaterThanOrEqual(0);
  });

  it('leaves the context as it found it', () => {
    const { ctx, ops } = stubContext();
    drawClubBadge(ctx, FRAME.width, FRAME.height, KIT, PLACE);
    // The readout is drawn straight after, with its own font and alignment; a
    // badge that left textAlign on 'left' would move the time.
    expect(ops[0]).toEqual(['save']);
    expect(ops[ops.length - 1]).toEqual(['restore']);
  });
});

describe('clubBadgeRect', () => {
  it.each([
    ['the default corner', KIT, PLACE, {}],
    ['a logo beside the name', { ...KIT, logo: { nodeName: 'IMG' } }, PLACE, {}],
    ['a logo and no name', { ...KIT, name: '', logo: { nodeName: 'IMG' } }, PLACE, {}],
    ['a long name', { ...KIT, name: 'Greater Vancouver Advanced Communicators Club' }, PLACE, { charWidth: 40 }],
    ['dragged to the bottom-right', KIT, { ...PLACE, x: 1, y: 1 }, {}],
    ['dragged to the top-left and scaled up', KIT, { ...PLACE, x: 0, y: 0, scale: 0.28 }, {}],
  ])('matches the rect drawClubBadge returns: %s', (_label, kit, placement, measure) => {
    // The camera foreground is cropped to this rect before anything is drawn,
    // so a mismatch would cut the badge off.
    const { ctx } = stubContext(measure);
    const drawn = drawClubBadge(ctx, FRAME.width, FRAME.height, kit, placement);

    expect(clubBadgeRect(stubContext(measure).ctx, FRAME.width, FRAME.height, kit, placement)).toEqual(drawn);
  });

  it('draws nothing and leaves the context as it found it', () => {
    const { ctx, ops } = stubContext();
    ctx.font = 'bold 40px sans-serif';

    clubBadgeRect(ctx, FRAME.width, FRAME.height, KIT, PLACE);

    expect(ops.map(([op]) => op)).toEqual(['save', 'restore']);
  });

  it('is null whenever drawClubBadge would draw nothing', () => {
    const { ctx, ops } = stubContext();

    expect(clubBadgeRect(ctx, FRAME.width, FRAME.height, { ...KIT, showOnCards: false }, PLACE)).toBeNull();
    expect(clubBadgeRect(ctx, FRAME.width, FRAME.height, KIT, { ...PLACE, visible: false })).toBeNull();
    expect(clubBadgeRect(ctx, FRAME.width, FRAME.height, null, PLACE)).toBeNull();
    expect(clubBadgeRect(null, FRAME.width, FRAME.height, KIT, PLACE)).toBeNull();
    expect(ops).toHaveLength(0);
  });
});

describe('placement arithmetic', () => {
  it('clamps a scale into the range the +/- buttons step through', () => {
    expect(clampBadgeScale(999)).toBe(BADGE_SCALE_MAX);
    expect(clampBadgeScale(0)).toBe(BADGE_SCALE_MIN);
    expect(clampBadgeScale('nonsense')).toBe(DEFAULT_BADGE_PLACEMENT.scale);
  });

  it('falls back field by field, so a sparse override keeps the club default', () => {
    const club = { x: 0.3, y: 0.7, scale: 0.2, visible: true };
    expect(normalizeBadgePlacement({ x: 0.9, y: 0.05 }, club)).toEqual({
      x: 0.9,
      y: 0.05,
      scale: 0.2,
      visible: true,
    });
  });

  it('ellipsizes against the context that will draw the text', () => {
    const { ctx } = stubContext({ charWidth: 10 });
    expect(ellipsizeText(ctx, 'Downtown', 1000)).toBe('Downtown');
    expect(ellipsizeText(ctx, 'Downtown Speakers', 50)).toBe('Down…');
    expect(ellipsizeText(ctx, 'Downtown', 0)).toBe('');
  });
});

describe('badgeUnchanged', () => {
  const a = { kit: { ...KIT }, placement: { ...PLACE } };

  it('treats two absent badges as identical', () => {
    expect(badgeUnchanged(null, null)).toBe(true);
    expect(badgeUnchanged(a, null)).toBe(false);
  });

  it('notices a move the readout would not', () => {
    // The whole reason this function exists: the dirty-check compares the
    // readout's own fields, so a badge that moved while the label stayed put
    // would compare equal and never repaint.
    expect(badgeUnchanged(a, { ...a, placement: { ...PLACE, x: 0.4 } })).toBe(false);
    expect(badgeUnchanged(a, { ...a, placement: { ...PLACE, scale: 0.2 } })).toBe(false);
  });

  it('notices the logo landing after its decode', () => {
    expect(badgeUnchanged(a, { ...a, kit: { ...KIT, logo: { nodeName: 'IMG' } } })).toBe(false);
  });

  it('is true for a re-read of the same state', () => {
    expect(badgeUnchanged(a, { kit: { ...KIT }, placement: { ...PLACE } })).toBe(true);
  });
});

// ---------------------------------------------------------------------------

function seedClub(over = {}) {
  localStorage.setItem(
    CLUB_STORAGE_KEY,
    JSON.stringify({
      clubToken: 'tok',
      ver: 3,
      club: { id: 'club-1', name: 'Downtown Speakers' },
      kit: { name: 'Downtown Speakers', logoUrl: null, primaryColor: '#123456', showOnCards: true, showOnReports: true },
      badge: { x: 0.7, y: 0.2, scale: 0.15 },
      entitled: true,
      plan: 'pro',
      lastRefreshAt: Date.now(),
      ...over,
    })
  );
  resetClubForTests();
}

describe('the kit a device renders from', () => {
  it('is null without a club', () => {
    expect(clubKit()).toBeNull();
    expect(clubBadgeState()).toBeNull();
  });

  it('is null for a lapsed club, while the cached club itself survives', () => {
    // The device keeps knowing which club to check, so renewal needs no
    // re-activation — it just stops rendering the club's identity.
    seedClub({ entitled: false, plan: 'free' });
    expect(clubKit()).toBeNull();
    expect(clubBadgeState()).toBeNull();
    expect(localStorage.getItem(CLUB_STORAGE_KEY)).toBeTruthy();
  });

  it('falls back to Toastmasters maroon when no colour was set', () => {
    seedClub({ kit: { name: 'Downtown Speakers' } });
    expect(clubKit()).toMatchObject({ primaryColor: DEFAULT_PRIMARY_COLOR, showOnCards: true, showOnReports: true });
  });

  it('answers nothing to draw when the club turned "Show on cards" off', () => {
    seedClub({ kit: { name: 'Downtown Speakers', showOnCards: false } });
    expect(clubKit().showOnCards).toBe(false);
    expect(clubBadgeState()).toBeNull();
  });
});

describe('the badge placement on this device', () => {
  it('starts at the club\'s published placement', () => {
    seedClub();
    expect(clubBadgeDefault()).toEqual({ x: 0.7, y: 0.2, scale: 0.15, visible: true });
    expect(clubBadgePlacement()).toEqual({ x: 0.7, y: 0.2, scale: 0.15, visible: true });
    expect(hasClubBadgeOverride()).toBe(false);
  });

  it('keeps a move on this device, field by field', () => {
    seedClub();

    saveClubBadgeOverride({ x: 0.2, y: 0.9 });

    expect(clubBadgePlacement()).toEqual({ x: 0.2, y: 0.9, scale: 0.15, visible: true });
    expect(hasClubBadgeOverride()).toBe(true);
    // The move is device-local, always: it is about where this organizer's own
    // face is, which is not something to push onto every other timer.
    expect(localStorage.getItem(CLUB_BADGE_STORAGE_KEY)).toBeTruthy();
  });

  it('hides the badge independently of the count-up', () => {
    seedClub();
    saveClubBadgeOverride({ visible: false });
    expect(clubBadgeState()).toBeNull();
    expect(clubBadgePlacement().visible).toBe(false);
  });

  it('puts the badge back where the club put it', () => {
    seedClub();
    saveClubBadgeOverride({ x: 0.2, y: 0.9, scale: 0.25 });

    clearClubBadgeOverride();

    expect(clubBadgePlacement()).toEqual({ x: 0.7, y: 0.2, scale: 0.15, visible: true });
    expect(hasClubBadgeOverride()).toBe(false);
  });

  it('follows a republished club default for every field nobody touched', () => {
    seedClub();
    saveClubBadgeOverride({ scale: 0.25 });

    seedClub({ badge: { x: 0.1, y: 0.1, scale: 0.05 } });

    expect(clubBadgePlacement()).toEqual({ x: 0.1, y: 0.1, scale: 0.25, visible: true });
  });

  it('goes away with the club', () => {
    seedClub();
    saveClubBadgeOverride({ x: 0.2 });

    leaveClub();

    expect(localStorage.getItem(CLUB_BADGE_STORAGE_KEY)).toBeNull();
    expect(clubBadgeState()).toBeNull();
  });
});

describe('the logo bitmap', () => {
  it('is decoded once and handed to the compositor', async () => {
    seedClub({
      kit: { name: 'Downtown Speakers', logoUrl: '/api/club-assets/club-1/abc', primaryColor: '#123456', showOnCards: true },
    });
    const image = { nodeName: 'IMG' };
    let loads = 0;
    const loadImage = async () => {
      loads += 1;
      return image;
    };

    await warmClubLogo({ loadImage });
    await warmClubLogo({ loadImage });

    expect(loads).toBe(1);
    expect(getClubLogoImage()).toBe(image);
    expect(clubBadgeState().kit.logo).toBe(image);
  });

  it('leaves a name-only badge when the logo will not load', async () => {
    seedClub({
      kit: { name: 'Downtown Speakers', logoUrl: '/api/club-assets/club-1/abc', showOnCards: true },
    });

    // Never rejects: a badge is a bonus, and the card's colour is the signal.
    await expect(
      warmClubLogo({ loadImage: () => Promise.reject(new Error('404')) })
    ).resolves.toBeNull();

    expect(clubBadgeState().kit.logo).toBeNull();
    expect(clubBadgeState().kit.name).toBe('Downtown Speakers');
  });
});
