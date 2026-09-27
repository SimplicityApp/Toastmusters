import { ellipsizeText, DEFAULT_PRIMARY_COLOR } from './clubBadge.js';

/**
 * The club's timing report, as a picture that can travel.
 *
 * Drawn with explicit canvas 2D calls rather than screenshotted from the DOM,
 * because the output size is set by where it is *going* — a chat preview — not
 * by where it is rendered. The Zoom sidebar is 280–400 px wide, so any
 * screenshot approach needs a hidden 1200 px clone of the Report tab, which
 * means a second report component to keep in visual step with the real one.
 * One routine, no DOM, no new dependency — the same technique `drawClubBadge`
 * and `drawTimeReadout` already use, and testable the same way: against a
 * stubbed 2D context, with no browser.
 *
 * The device draws it and the Worker only serves it, which is what guarantees
 * the chat preview can never drift from what the timer saw when they tapped
 * Copy image.
 */

/** Wide enough for a chat preview to render it without upscaling. */
export const REPORT_IMAGE_WIDTH = 1200;
/** The brand block plus the table's column header. */
export const REPORT_HEADER_HEIGHT = 140;
export const REPORT_ROW_HEIGHT = 44;
export const REPORT_FOOTER_HEIGHT = 40;
/** 1.91:1 — what every chat and social preview crops to. */
export const PREVIEW_IMAGE_HEIGHT = 630;
/**
 * Six rows, then "…and N more".
 *
 * The two variants exist because a 30-speech meeting rendered full-height makes
 * a tall, thin image that a chat preview crops to a band of nothing.
 */
export const PREVIEW_MAX_ROWS = 6;

const PADDING = 48;
const ACCENT_BAR_HEIGHT = 8;
const FOOTER_TEXT = 'Timed with Toastmusters Timer';

const FONT_STACK = `'Helvetica Neue', Helvetica, Arial, sans-serif`;

/**
 * Column geometry, in the order a Toastmasters timer reads it.
 *
 * Fixed rather than measured: every report has the same five columns, and a
 * layout that moved with the content would make two meetings of the same club
 * look like two different documents.
 */
const COLUMNS = [
  { key: 'name', label: 'Name', x: PADDING, width: 280, bold: true },
  { key: 'role', label: 'Role', x: 344, width: 250 },
  { key: 'duration', label: 'Time', x: 610, width: 110, mono: true },
  { key: 'color', label: 'Result', x: 736, width: 110 },
  { key: 'comments', label: 'Comments', x: 862, width: 290 },
];

/** The dot beside a result, in the same four colours the cards use. */
const RESULT_COLORS = {
  green: '#16a34a',
  yellow: '#eab308',
  red: '#dc2626',
  blue: '#2563eb',
};

const INK = '#111827';
const MUTED = '#6b7280';
const RULE = '#e5e7eb';
const STRIPE = '#f9fafb';

/** How tall a 'full' report with this many speeches comes out. */
export function reportImageHeight(rows) {
  const count = Math.max(0, Number(rows) || 0);
  return REPORT_HEADER_HEIGHT + REPORT_ROW_HEIGHT * count + REPORT_FOOTER_HEIGHT;
}

function defaultCreateCanvas(width, height) {
  if (typeof document !== 'undefined' && document.createElement) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  throw new Error('No canvas to draw the report on');
}

/**
 * `canvas.toBlob` where there is one, `convertToBlob` on an OffscreenCanvas.
 *
 * Never rejects on a missing encoder: a device that cannot produce a PNG still
 * has the Report tab and "Copy as text", and the caller decides what to say.
 */
function canvasToBlob(canvas) {
  return new Promise((resolve) => {
    try {
      if (typeof canvas.toBlob === 'function') {
        canvas.toBlob((blob) => resolve(blob ?? null), 'image/png');
        return;
      }
      if (typeof canvas.convertToBlob === 'function') {
        canvas.convertToBlob({ type: 'image/png' }).then(resolve, () => resolve(null));
        return;
      }
    } catch {
      // Fall through: no encoder is a null, not a throw.
    }
    resolve(null);
  });
}

const DATE_FORMAT = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' };

/**
 * `2026-09-29` or `20260929` → `Tue, 29 Sep 2026`.
 *
 * Noon rather than midnight so a date-only string is not pulled into the
 * previous day by the reader's own timezone.
 */
export function readableReportDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const raw = String(value);
  const digits = raw.replace(/\D/g, '');
  const iso =
    /^\d{4}-\d{2}-\d{2}$/.test(raw)
      ? `${raw}T12:00:00`
      : digits.length >= 8
        ? `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}T12:00:00`
        : raw;
  const when = new Date(iso);
  return Number.isNaN(when.getTime()) ? null : when.toLocaleDateString(undefined, DATE_FORMAT);
}

/** Up to two letters, for the mark a club without a logo gets. */
function initials(name) {
  return String(name ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join('');
}

/** A count that reads as a sentence: "14 speeches · 3 over time". */
export function reportSummaryLine(speeches = [], { date } = {}) {
  const rows = Array.isArray(speeches) ? speeches : [];
  const overtime = rows.filter(isOvertime).length;
  const parts = [`${rows.length} ${rows.length === 1 ? 'speech' : 'speeches'}`];
  if (overtime > 0) parts.push(`${overtime} over time`);
  const printed = readableReportDate(date);
  if (printed) parts.push(printed);
  return parts.join(' · ');
}

/** The same rule the Worker writes into a meeting's KV metadata. */
export const isOvertime = (speech) => speech?.color === 'red' || speech?.disqualified === true;

/** A hand-rolled rounded rect: `ctx.roundRect` is too new for every webview. */
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

function drawHeader(ctx, { clubName, primaryColor, logo, date, label }) {
  // The accent bar carries the club's colour even when the logo is a
  // transparent PNG that reads as nothing against white.
  ctx.fillStyle = primaryColor;
  ctx.fillRect(0, 0, REPORT_IMAGE_WIDTH, ACCENT_BAR_HEIGHT);

  const markSize = 64;
  const markTop = 30;
  ctx.fillStyle = primaryColor;
  roundedRectPath(ctx, PADDING, markTop, markSize, markSize, 12);
  ctx.fill();

  if (logo) {
    const inset = 8;
    ctx.drawImage(logo, PADDING + inset, markTop + inset, markSize - inset * 2, markSize - inset * 2);
  } else {
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold 26px ${FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(initials(clubName), PADDING + markSize / 2, markTop + markSize / 2);
  }

  const textLeft = PADDING + markSize + 20;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = INK;
  ctx.font = `bold 34px ${FONT_STACK}`;
  ctx.fillText(ellipsizeText(ctx, clubName, REPORT_IMAGE_WIDTH - PADDING - textLeft), textLeft, markTop + 30);

  ctx.fillStyle = MUTED;
  ctx.font = `20px ${FONT_STACK}`;
  const printed = readableReportDate(date);
  const subtitle = printed ? `${label} · ${printed}` : label;
  ctx.fillText(ellipsizeText(ctx, subtitle, REPORT_IMAGE_WIDTH - PADDING - textLeft), textLeft, markTop + 60);

  // The column header sits in the header block, which is what makes the full
  // variant exactly 180 + 44·rows tall.
  const headerRowTop = REPORT_HEADER_HEIGHT - REPORT_ROW_HEIGHT;
  ctx.fillStyle = '#f3f4f6';
  ctx.fillRect(0, headerRowTop, REPORT_IMAGE_WIDTH, REPORT_ROW_HEIGHT);
  ctx.fillStyle = MUTED;
  ctx.font = `bold 18px ${FONT_STACK}`;
  ctx.textBaseline = 'middle';
  for (const column of COLUMNS) {
    ctx.fillText(column.label, column.x, headerRowTop + REPORT_ROW_HEIGHT / 2);
  }
}

function drawRow(ctx, speech, index, top) {
  if (index % 2 === 1) {
    ctx.fillStyle = STRIPE;
    ctx.fillRect(0, top, REPORT_IMAGE_WIDTH, REPORT_ROW_HEIGHT);
  }
  ctx.fillStyle = RULE;
  ctx.fillRect(0, top + REPORT_ROW_HEIGHT - 1, REPORT_IMAGE_WIDTH, 1);

  const middle = top + REPORT_ROW_HEIGHT / 2;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  for (const column of COLUMNS) {
    if (column.key === 'color') {
      const dot = RESULT_COLORS[speech.color];
      let textLeft = column.x;
      if (dot) {
        ctx.fillStyle = dot;
        roundedRectPath(ctx, column.x, middle - 7, 14, 14, 7);
        ctx.fill();
        textLeft = column.x + 22;
      }
      ctx.fillStyle = speech.disqualified ? RESULT_COLORS.red : MUTED;
      ctx.font = `${speech.disqualified ? 'bold ' : ''}18px ${FONT_STACK}`;
      const word = speech.disqualified ? 'Over' : String(speech.color ?? '');
      ctx.fillText(ellipsizeText(ctx, word, column.width - (textLeft - column.x)), textLeft, middle);
      continue;
    }

    const value = String(speech[column.key] ?? '');
    ctx.fillStyle = column.bold ? INK : MUTED;
    ctx.font = `${column.bold ? 'bold ' : ''}${column.mono ? '19px monospace' : `19px ${FONT_STACK}`}`;
    // Every cell is ellipsized: a club with a "Evaluator for the Ice Breaker"
    // role must not push the comments column off the picture.
    ctx.fillText(ellipsizeText(ctx, value, column.width - 16), column.x, middle);
  }
}

function drawFooter(ctx, height, { hidden = 0 } = {}) {
  const top = height - REPORT_FOOTER_HEIGHT;
  ctx.fillStyle = RULE;
  ctx.fillRect(0, top, REPORT_IMAGE_WIDTH, 1);
  ctx.textBaseline = 'middle';
  ctx.fillStyle = MUTED;
  ctx.font = `16px ${FONT_STACK}`;
  ctx.textAlign = 'left';
  ctx.fillText(FOOTER_TEXT, PADDING, top + REPORT_FOOTER_HEIGHT / 2);
  if (hidden > 0) {
    ctx.textAlign = 'right';
    ctx.fillText(`…and ${hidden} more`, REPORT_IMAGE_WIDTH - PADDING, top + REPORT_FOOTER_HEIGHT / 2);
  }
  ctx.textAlign = 'left';
}

/**
 * Draw the club's timing report.
 *
 *   variant 'full'      1200 × (180 + 44·rows)   every speech — Copy image
 *   variant 'preview'   1200 × 630               six rows + "…and N more" — the OG image
 *
 * @param {{club?: Object|null, kit?: Object|null, meeting?: Object|null,
 *   speeches?: Array<Object>}} report
 * @param {{variant?: 'full'|'preview', createCanvas?: Function,
 *   logo?: CanvasImageSource|null, label?: string}} [options]
 * @returns {Promise<Blob|null>} null when the device has no PNG encoder
 */
export async function renderReportPng(
  { club = null, kit = null, meeting = null, speeches = [] } = {},
  { variant = 'full', createCanvas = defaultCreateCanvas, logo = null, label = 'Timing report' } = {}
) {
  const rows = Array.isArray(speeches) ? speeches : [];
  const preview = variant === 'preview';
  const shown = preview ? rows.slice(0, PREVIEW_MAX_ROWS) : rows;
  const hidden = rows.length - shown.length;

  const height = preview ? PREVIEW_IMAGE_HEIGHT : reportImageHeight(shown.length);
  const canvas = createCanvas(REPORT_IMAGE_WIDTH, height);
  // A stub canvas in a test gets its size from the constructor; a real one
  // needs it assigned, and assigning it also clears the bitmap.
  canvas.width = REPORT_IMAGE_WIDTH;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const clubName = String(kit?.name ?? club?.name ?? club?.club?.name ?? 'Timing report').trim();
  const primaryColor = kit?.primaryColor || DEFAULT_PRIMARY_COLOR;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, REPORT_IMAGE_WIDTH, height);

  drawHeader(ctx, {
    clubName,
    primaryColor,
    logo,
    date: meeting?.date ?? meeting?.meetingId ?? null,
    label: meeting?.title ? String(meeting.title) : label,
  });

  shown.forEach((speech, index) => {
    drawRow(ctx, speech ?? {}, index, REPORT_HEADER_HEIGHT + index * REPORT_ROW_HEIGHT);
  });

  drawFooter(ctx, height, { hidden: preview ? hidden : 0 });

  return canvasToBlob(canvas);
}

/** `downtown-speakers-2026-09-29.png` — a filename a person can find again. */
export function reportImageFilename({ clubName, date } = {}) {
  const slug = String(clubName ?? 'timing-report')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'timing-report';
  const digits = String(date ?? '').replace(/\D/g, '');
  const day = digits.length >= 8 ? `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}` : null;
  return day ? `${slug}-${day}.png` : `${slug}.png`;
}

/**
 * Put the picture where the timer can paste it.
 *
 * Best-effort, mirroring the TSV path `ReportTab` already ships: the clipboard
 * first, and a download when that is refused — which is likely the real path
 * inside the Zoom webview, where the clipboard image permission is not granted.
 *
 * @param {Blob} blob
 * @param {{filename?: string, clipboard?: Clipboard, itemFactory?: Function,
 *   documentImpl?: Document}} [options]
 * @returns {Promise<{ok: boolean, method: 'clipboard'|'download'|null}>} never rejects
 */
export async function copyReportImage(blob, { filename = 'timing-report.png', clipboard, itemFactory, documentImpl } = {}) {
  if (!blob) return { ok: false, method: null };

  const board = clipboard ?? (typeof navigator !== 'undefined' ? navigator.clipboard : null);
  const Item = itemFactory ?? (typeof ClipboardItem !== 'undefined' ? ClipboardItem : null);
  if (board?.write && Item) {
    try {
      await board.write([new Item({ 'image/png': blob })]);
      return { ok: true, method: 'clipboard' };
    } catch {
      // Refused, or unsupported. The download below is the real path in Zoom.
    }
  }

  const doc = documentImpl ?? (typeof document !== 'undefined' ? document : null);
  if (!doc || typeof URL === 'undefined' || !URL.createObjectURL) return { ok: false, method: null };

  try {
    const href = URL.createObjectURL(blob);
    const link = doc.createElement('a');
    link.href = href;
    link.download = filename;
    doc.body?.appendChild(link);
    link.click();
    link.remove?.();
    // Long enough for the download to have been handed off; revoking straight
    // away cancels it in some browsers.
    setTimeout(() => URL.revokeObjectURL(href), 10_000);
    return { ok: true, method: 'download' };
  } catch {
    return { ok: false, method: null };
  }
}
