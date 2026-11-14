/**
 * A one-line announcement under the app's header: an icon, an optional bold
 * lead, the message, an optional link, and an × to close it.
 *
 * Presentational, like everything in this package: which announcement to show,
 * remembering that it was closed and opening the link are the app's job (see
 * `pickAnnouncement` in `@toastmaster-timer/shared`).
 */

const STROKE = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': 'true',
};

// Whole class strings, so Tailwind's scan of this file keeps every one of them.
const TONES = {
  info: {
    box: 'border-blue-100 bg-blue-50',
    icon: 'text-blue-600',
    text: 'text-blue-900',
    link: 'text-blue-800 hover:text-blue-950',
    close: 'text-blue-700 hover:bg-blue-100 hover:text-blue-900',
  },
  success: {
    box: 'border-green-200 bg-green-50',
    icon: 'text-green-600',
    text: 'text-green-900',
    link: 'text-green-800 hover:text-green-950',
    close: 'text-green-700 hover:bg-green-100 hover:text-green-900',
  },
  warning: {
    box: 'border-amber-200 bg-amber-50',
    icon: 'text-amber-600',
    text: 'text-amber-900',
    link: 'text-amber-800 hover:text-amber-950',
    close: 'text-amber-700 hover:bg-amber-100 hover:text-amber-900',
  },
};

function ToneIcon({ tone, className }) {
  if (tone === 'warning') {
    return (
      <svg {...STROKE} className={className}>
        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
        <path d="M12 9v4" />
        <path d="M12 17h.01" />
      </svg>
    );
  }
  return (
    <svg {...STROKE} className={className}>
      <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z" />
      <path d="M5 3v4" />
      <path d="M19 17v4" />
      <path d="M3 5h4" />
      <path d="M17 19h4" />
    </svg>
  );
}

/**
 * @param {Object} props
 * @param {string} props.id - recorded on the element, for tests and analytics
 * @param {string} [props.lead] - bold opener, e.g. "Coming soon:"
 * @param {string} props.text
 * @param {'info'|'success'|'warning'} [props.tone]
 * @param {string} [props.linkLabel]
 * @param {() => void} [props.onLink] - the link shows only with a label and this
 * @param {() => void} [props.onDismiss] - the × shows only with this
 */
export default function AnnouncementBanner({ id, lead, text, tone = 'info', linkLabel, onLink, onDismiss }) {
  if (!text) return null;
  const style = TONES[tone] ?? TONES.info;

  return (
    <div
      role="status"
      data-testid="announcement-banner"
      data-announcement-id={id}
      className={`flex items-center gap-2 border-b px-3 py-2 ${style.box}`}
    >
      <ToneIcon tone={tone} className={`h-4 w-4 flex-shrink-0 ${style.icon}`} />
      <p className={`min-w-0 flex-1 text-sm ${style.text}`}>
        {lead && <span className="font-semibold">{lead}</span>}
        {lead && ' '}
        {text}
        {linkLabel && onLink && (
          <>
            {' '}
            <button type="button" onClick={onLink} className={`font-medium underline ${style.link}`}>
              {linkLabel}
            </button>
          </>
        )}
      </p>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className={`flex-shrink-0 rounded p-1 ${style.close}`}
        >
          <svg {...STROKE} className="h-4 w-4">
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </button>
      )}
    </div>
  );
}
