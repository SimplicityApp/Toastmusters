import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  renderReportPng,
  copyReportImage,
  reportImageFilename,
  reportImageHeight,
  reportSummaryLine,
  readableReportDate,
  REPORT_IMAGE_WIDTH,
  PREVIEW_IMAGE_HEIGHT,
  PREVIEW_MAX_ROWS,
  REPORT_HEADER_HEIGHT,
  REPORT_ROW_HEIGHT,
  REPORT_FOOTER_HEIGHT,
} from '../reportImage.js';

/**
 * The report as a picture.
 *
 * Drawn against a stubbed 2D context rather than a real canvas, the same way
 * clubBadge.test.js asserts on drawClubBadge: no browser, no image fixtures,
 * and every draw call visible in order.
 */

/** A canvas whose context records everything asked of it. */
function stubCanvas({ charWidth = 9, noEncoder = false } = {}) {
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
    fillRect: (...a) => ops.push(['fillRect', ...a, ctx.fillStyle]),
    drawImage: (image, ...a) => ops.push(['drawImage', image, ...a]),
    fillText: (text, x, y) => ops.push(['fillText', text, x, y, ctx.fillStyle]),
    measureText: (text) => ({ width: String(text).length * charWidth }),
  };
  const sizes = [];
  const createCanvas = (width, height) => {
    sizes.push({ width, height });
    return {
      width,
      height,
      getContext: () => ctx,
      ...(noEncoder
        ? {}
        : { toBlob: (cb) => cb({ type: 'image/png', size: 1024 }) }),
    };
  };
  return { ops, sizes, createCanvas };
}

const textOf = (ops) => ops.filter(([op]) => op === 'fillText').map(([, text]) => text);

const KIT = { name: 'Downtown Speakers', primaryColor: '#772432', showOnReports: true };
const MEETING = { meetingId: '20260929', date: '2026-09-29', title: null };

const speech = (over = {}) => ({
  name: 'Alice',
  role: 'Standard Speech',
  duration: '5:50',
  color: 'green',
  comments: '',
  disqualified: false,
  ...over,
});

const manySpeeches = (count) =>
  Array.from({ length: count }, (_, i) => speech({ name: `Speaker ${i + 1}` }));

describe('canvas dimensions', () => {
  it('sizes the full variant to fit every speech', async () => {
    const { sizes, createCanvas } = stubCanvas();

    await renderReportPng({ kit: KIT, meeting: MEETING, speeches: manySpeeches(14) }, { createCanvas });

    expect(sizes[0]).toEqual({
      width: REPORT_IMAGE_WIDTH,
      // The formula the whole layout is built around: the column header lives
      // inside the 140px header block, so the height is exactly 180 + 44·rows.
      height: REPORT_HEADER_HEIGHT + REPORT_ROW_HEIGHT * 14 + REPORT_FOOTER_HEIGHT,
    });
    expect(sizes[0].height).toBe(reportImageHeight(14));
    expect(sizes[0].height).toBe(180 + 44 * 14);
  });

  it('pins the preview variant to 1200 × 630 however long the meeting was', async () => {
    const { sizes, createCanvas } = stubCanvas();

    await renderReportPng({ kit: KIT, meeting: MEETING, speeches: manySpeeches(30) }, { createCanvas, variant: 'preview' });

    // A 30-speech meeting rendered full-height makes a tall, thin image that a
    // chat preview crops to a band of nothing. 1.91:1 is what they all want.
    expect(sizes[0]).toEqual({ width: REPORT_IMAGE_WIDTH, height: PREVIEW_IMAGE_HEIGHT });
  });

  it('still draws a header and a footer for a meeting with no speeches', async () => {
    const { sizes, ops, createCanvas } = stubCanvas();

    await renderReportPng({ kit: KIT, meeting: MEETING, speeches: [] }, { createCanvas });

    expect(sizes[0].height).toBe(REPORT_HEADER_HEIGHT + REPORT_FOOTER_HEIGHT);
    expect(textOf(ops)).toContain('Downtown Speakers');
    expect(textOf(ops)).toContain('Timed with Toastmusters Timer');
  });
});

describe('the preview variant', () => {
  it('caps at six rows and says how many it left out', async () => {
    const { ops, createCanvas } = stubCanvas();

    await renderReportPng({ kit: KIT, meeting: MEETING, speeches: manySpeeches(15) }, { createCanvas, variant: 'preview' });

    const names = textOf(ops).filter((text) => String(text).startsWith('Speaker '));
    expect(names).toHaveLength(PREVIEW_MAX_ROWS);
    expect(names[0]).toBe('Speaker 1');
    expect(names[5]).toBe('Speaker 6');
    expect(textOf(ops)).toContain('…and 9 more');
  });

  it('says nothing about extra rows when the whole meeting fits', async () => {
    const { ops, createCanvas } = stubCanvas();

    await renderReportPng({ kit: KIT, meeting: MEETING, speeches: manySpeeches(4) }, { createCanvas, variant: 'preview' });

    expect(textOf(ops).some((text) => String(text).startsWith('…and'))).toBe(false);
  });

  // The full variant is the one the timer copies, so it never elides anything.
  it('never elides rows in the full variant', async () => {
    const { ops, createCanvas } = stubCanvas();

    await renderReportPng({ kit: KIT, meeting: MEETING, speeches: manySpeeches(15) }, { createCanvas });

    expect(textOf(ops).filter((t) => String(t).startsWith('Speaker '))).toHaveLength(15);
    expect(textOf(ops).some((text) => String(text).includes('more'))).toBe(false);
  });
});

describe('what the header says', () => {
  it('names the club, the date and the club colour', async () => {
    const { ops, createCanvas } = stubCanvas();

    await renderReportPng({ kit: KIT, meeting: MEETING, speeches: [speech()] }, { createCanvas });

    expect(textOf(ops)).toContain('Downtown Speakers');
    // The accent bar and the logo tile both carry the club's own colour.
    expect(ops.some(([op, , , , , style]) => op === 'fillRect' && style === '#772432')).toBe(true);
    expect(textOf(ops).some((text) => String(text).includes('Timing report'))).toBe(true);
  });

  it('uses the meeting title as the label once it has one', async () => {
    const { ops, createCanvas } = stubCanvas();

    await renderReportPng(
      { kit: KIT, meeting: { ...MEETING, title: 'Humorous Speech Contest' }, speeches: [speech()] },
      { createCanvas }
    );

    expect(textOf(ops).some((text) => String(text).includes('Humorous Speech Contest'))).toBe(true);
  });

  it('falls back to initials when the club has no logo, and draws the logo when it does', async () => {
    const withoutLogo = stubCanvas();
    await renderReportPng({ kit: KIT, meeting: MEETING, speeches: [] }, { createCanvas: withoutLogo.createCanvas });
    expect(textOf(withoutLogo.ops)).toContain('DS');
    expect(withoutLogo.ops.some(([op]) => op === 'drawImage')).toBe(false);

    const withLogo = stubCanvas();
    const logo = { nodeName: 'IMG' };
    await renderReportPng({ kit: KIT, meeting: MEETING, speeches: [] }, { createCanvas: withLogo.createCanvas, logo });
    expect(withLogo.ops.some(([op, image]) => op === 'drawImage' && image === logo)).toBe(true);
    expect(textOf(withLogo.ops)).not.toContain('DS');
  });
});

describe('long values', () => {
  it('ellipsizes a club name that would run off the picture', async () => {
    const { ops, createCanvas } = stubCanvas({ charWidth: 40 });

    await renderReportPng(
      { kit: { ...KIT, name: 'Greater Vancouver Advanced Communicators Club' }, meeting: MEETING, speeches: [] },
      { createCanvas }
    );

    const drawn = textOf(ops).find((text) => String(text).startsWith('Greater'));
    expect(drawn.endsWith('…')).toBe(true);
    expect(drawn.length).toBeLessThan('Greater Vancouver Advanced Communicators Club'.length);
  });

  it('ellipsizes a long name and a long comment rather than overlapping the next column', async () => {
    const { ops, createCanvas } = stubCanvas({ charWidth: 20 });

    await renderReportPng(
      {
        kit: KIT,
        meeting: MEETING,
        speeches: [
          speech({
            name: 'Bartholomew Fitzgerald-Montgomery',
            comments: 'Passed red by forty seconds and kept going for quite a while after that',
          }),
        ],
      },
      { createCanvas }
    );

    const drawn = textOf(ops);
    expect(drawn.some((text) => String(text).startsWith('Bartholomew') && String(text).endsWith('…'))).toBe(true);
    expect(drawn.some((text) => String(text).startsWith('Passed red') && String(text).endsWith('…'))).toBe(true);
  });
});

describe('a speech that ran over', () => {
  it('is marked Over rather than shown as a colour', async () => {
    const { ops, createCanvas } = stubCanvas();

    await renderReportPng(
      { kit: KIT, meeting: MEETING, speeches: [speech({ color: 'red', disqualified: true })] },
      { createCanvas }
    );

    expect(textOf(ops)).toContain('Over');
  });
});

describe('encoding', () => {
  it('hands back the PNG blob the canvas produced', async () => {
    const { createCanvas } = stubCanvas();

    const blob = await renderReportPng({ kit: KIT, meeting: MEETING, speeches: [speech()] }, { createCanvas });

    expect(blob).toEqual({ type: 'image/png', size: 1024 });
  });

  // A device with no PNG encoder still has the Report tab and "Copy as text";
  // nothing here may throw into the meeting.
  it('answers null rather than throwing when there is no encoder', async () => {
    const { createCanvas } = stubCanvas({ noEncoder: true });

    await expect(
      renderReportPng({ kit: KIT, meeting: MEETING, speeches: [speech()] }, { createCanvas })
    ).resolves.toBeNull();
  });

  it('answers null when the canvas has no 2D context at all', async () => {
    const createCanvas = () => ({ width: 0, height: 0, getContext: () => null });

    await expect(renderReportPng({ kit: KIT, meeting: MEETING }, { createCanvas })).resolves.toBeNull();
  });
});

describe('copyReportImage', () => {
  const blob = { type: 'image/png' };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('writes the picture to the clipboard when it can', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const itemFactory = vi.fn(function ClipboardItem(payload) {
      this.payload = payload;
    });

    const result = await copyReportImage(blob, { clipboard: { write }, itemFactory });

    expect(result).toEqual({ ok: true, method: 'clipboard' });
    expect(itemFactory).toHaveBeenCalledWith({ 'image/png': blob });
    expect(write).toHaveBeenCalledOnce();
  });

  // The likely path inside the Zoom webview, where writing an image to the
  // clipboard is refused.
  it('falls back to a download when the clipboard refuses', async () => {
    const write = vi.fn().mockRejectedValue(new Error('NotAllowedError'));
    const link = { click: vi.fn(), remove: vi.fn() };
    const documentImpl = { createElement: vi.fn(() => link), body: { appendChild: vi.fn() } };
    const createObjectURL = vi.fn(() => 'blob:report');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });

    const result = await copyReportImage(blob, {
      clipboard: { write },
      itemFactory: function ClipboardItem() {},
      documentImpl,
      filename: 'downtown-speakers-2026-09-29.png',
    });

    expect(result).toEqual({ ok: true, method: 'download' });
    expect(link.download).toBe('downtown-speakers-2026-09-29.png');
    expect(link.click).toHaveBeenCalledOnce();

    // Revoking straight away cancels the download in some browsers.
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:report');

    vi.unstubAllGlobals();
  });

  it('downloads directly when there is no clipboard API at all', async () => {
    const link = { click: vi.fn(), remove: vi.fn() };
    const documentImpl = { createElement: () => link, body: { appendChild: vi.fn() } };
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:report', revokeObjectURL: vi.fn() });

    const result = await copyReportImage(blob, { clipboard: null, itemFactory: null, documentImpl });

    expect(result).toEqual({ ok: true, method: 'download' });
    vi.unstubAllGlobals();
  });

  it('says so rather than throwing when there is no picture', async () => {
    await expect(copyReportImage(null)).resolves.toEqual({ ok: false, method: null });
  });
});

describe('filenames and summaries', () => {
  it('names the file after the club and the day', () => {
    expect(reportImageFilename({ clubName: 'Downtown Speakers', date: '2026-09-29' })).toBe(
      'downtown-speakers-2026-09-29.png'
    );
    expect(reportImageFilename({ clubName: 'Downtown Speakers' })).toBe('downtown-speakers.png');
    expect(reportImageFilename({})).toBe('timing-report.png');
  });

  it('summarises a meeting the way the share message and the OG description do', () => {
    const rows = [speech(), speech({ color: 'red' }), speech({ disqualified: true })];
    expect(reportSummaryLine(rows, { date: '2026-09-29' })).toContain('3 speeches');
    expect(reportSummaryLine(rows, { date: '2026-09-29' })).toContain('2 over time');
    expect(reportSummaryLine([speech()])).toBe('1 speech');
  });

  it('reads a date from either shape the archive stores it in', () => {
    expect(readableReportDate('2026-09-29')).toBe(readableReportDate('20260929'));
    expect(readableReportDate(null)).toBeNull();
    expect(readableReportDate('not-a-date')).toBeNull();
  });
});
