import { useState } from 'react';

/**
 * Where a finished meeting goes.
 *
 * Four destinations, each one tap, with the message already written — the
 * timer taps once and sends. WhatsApp and Email are the two places a club
 * report actually lands; "Copy image" is the one that works with no link at
 * all, which is why it stays available even when the upload failed.
 *
 * Presentational, like everything else in this package: it is handed a URL and
 * two callbacks and knows nothing about canvases, clubs or the network. Stock
 * Tailwind only, plus inline styles for the club's own colour — see README.md,
 * because `bg-cream` and `font-display` exist in apps/web and not in
 * apps/zoom-app and a class missing from one build fails silently.
 */

const DATE_FORMAT = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' };

/** `2026-09-29` or `20260929` → `Tue, 29 Sep 2026`. Noon, so no zone pulls it back a day. */
export function readableDate(value) {
  if (!value) return null;
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

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

/**
 * The message the timer sends, already written.
 *
 * Names the club, the date and the counts before the link, so it reads as
 * something a person wrote even in a chat that never expands the preview.
 *
 * @param {{clubName?: string, date?: string, title?: string|null,
 *   speeches?: number, overtime?: number, url?: string|null}} report
 * @returns {string}
 */
export function shareMessage({ clubName, date, title, speeches = 0, overtime = 0, url } = {}) {
  const when = readableDate(date);
  const what = title ? `${title}` : 'timing report';
  const opening = [`${clubName || 'Our club'} — ${what}${when ? `, ${when}` : ''}`];
  const counts = [plural(speeches, 'speech', 'speeches')];
  if (overtime > 0) counts.push(`${overtime} over time`);
  opening.push(counts.join(', ') + '.');
  if (url) opening.push(url);
  return opening.join('\n');
}

const BUTTON =
  'w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-gray-800 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed';

/**
 * @param {Object} props
 * @param {string} props.clubName
 * @param {string} [props.date] - the meeting's date
 * @param {string|null} [props.title] - the meeting's title, if it was given one
 * @param {number} [props.speeches]
 * @param {number} [props.overtime]
 * @param {string|null} [props.url] - the hosted report, when the upload landed
 * @param {string} [props.primaryColor]
 * @param {boolean} [props.imageReady] - whether a PNG is in hand
 * @param {string|null} [props.error] - a line of copy, already written
 * @param {(channel: string) => (void|Promise<any>)} props.onShare - every action
 *   reports itself here: 'whatsapp' | 'email' | 'image' | 'link'
 */
export default function ShareStep({
  clubName,
  date,
  title = null,
  speeches = 0,
  overtime = 0,
  url = null,
  primaryColor = '#772432',
  imageReady = true,
  error = null,
  onShare,
}) {
  const [copied, setCopied] = useState(null);

  const message = shareMessage({ clubName, date, title, speeches, overtime, url });
  const subject = `${clubName || 'Our club'} — ${title || 'timing report'}${
    readableDate(date) ? `, ${readableDate(date)}` : ''
  }`;

  const run = async (channel) => {
    const result = await onShare?.(channel);
    if (channel === 'image' || channel === 'link') {
      setCopied(result === false ? null : channel);
      setTimeout(() => setCopied(null), 2000);
    }
  };

  return (
    <div className="space-y-3" data-testid="share-step">
      <div>
        <p className="font-semibold text-gray-900">Share this meeting</p>
        <p className="text-xs text-gray-500">
          {plural(speeches, 'speech', 'speeches')}
          {overtime > 0 ? ` · ${overtime} over time` : ''}
          {readableDate(date) ? ` · ${readableDate(date)}` : ''}
        </p>
      </div>

      {/* The message, visible before it is sent: a timer about to post into
          their club's group chat should be able to read it first. */}
      <p
        className="whitespace-pre-line rounded-lg border-l-4 bg-gray-50 p-3 text-xs text-gray-700 break-words"
        style={{ borderLeftColor: primaryColor }}
        data-testid="share-message"
      >
        {message}
      </p>

      {error && (
        <p className="text-xs text-gray-500" data-testid="share-error">
          {error}
        </p>
      )}

      <div className="grid grid-cols-2 gap-2">
        <a
          className={`${BUTTON} block text-center ${url ? '' : 'pointer-events-none opacity-50'}`}
          href={`https://wa.me/?text=${encodeURIComponent(message)}`}
          target="_blank"
          rel="noreferrer"
          aria-disabled={url ? undefined : 'true'}
          onClick={() => onShare?.('whatsapp')}
        >
          WhatsApp
        </a>
        <a
          className={`${BUTTON} block text-center`}
          href={`mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(message)}`}
          onClick={() => onShare?.('email')}
        >
          Email
        </a>
        <button type="button" className={BUTTON} disabled={!imageReady} onClick={() => run('image')}>
          {copied === 'image' ? 'Image copied' : 'Copy image'}
        </button>
        <button type="button" className={BUTTON} disabled={!url} onClick={() => run('link')}>
          {copied === 'link' ? 'Link copied' : 'Copy link'}
        </button>
      </div>
    </div>
  );
}
