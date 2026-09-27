/**
 * The week of warning that comes before a club loses Pro.
 *
 * The server has carried this policy all along — a failed payment keeps Pro for
 * seven days, a scheduled cancellation keeps it until the paid period ends —
 * and this is the device following it out loud, so a club never discovers it
 * has lapsed by watching its branding vanish mid-meeting.
 *
 * Whoever is timing is rarely whoever pays, which decides both halves of the
 * copy: everyone is told who to ask, and only an admin is offered the billing
 * page they can actually act on.
 *
 * Dismiss is for today only. The reminder returns each day until the club is
 * renewed or lapses, because the person who can renew it may not have opened
 * the app yet.
 *
 * Stock Tailwind only — see README.md. `bg-cream` and `font-display` exist in
 * apps/web and not in apps/zoom-app, and a missing class fails silently. The
 * marks are inline SVG rather than `lucide-react` for the same reason the token
 * floor exists: this package has no node_modules of its own, so a bare import
 * from here fails one app's build outright.
 *
 * @param {Object} props
 * @param {string} props.clubName
 * @param {number|null} [props.daysLeft] - null when there is no date to give
 * @param {boolean} [props.isAdmin] - shows the billing action
 * @param {() => void} [props.onManageBilling]
 * @param {() => void} [props.onDismiss]
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

export default function ClubGraceBanner({
  clubName,
  daysLeft = null,
  isAdmin = false,
  onManageBilling,
  onDismiss,
}) {
  if (!clubName) return null;

  const when =
    daysLeft === null
      ? `${clubName}'s payment did not go through.`
      : daysLeft <= 0
        ? `${clubName}'s Pro ends today.`
        : daysLeft === 1
          ? `${clubName}'s Pro ends tomorrow.`
          : `${clubName}'s Pro ends in ${daysLeft} days.`;

  return (
    <div
      className="flex items-start gap-2 border-b border-amber-200 bg-amber-50 px-3 py-2"
      role="status"
      data-testid="club-grace-banner"
    >
      <svg {...STROKE} className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600">
        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
        <path d="M12 9v4" />
        <path d="M12 17h.01" />
      </svg>
      <div className="min-w-0 flex-1">
        <p className="text-sm text-amber-900">
          <span className="font-semibold">{when}</span>{' '}
          {isAdmin ? 'Renew to keep your presets, branding and archive.' : 'Ask your club admin to renew.'}
        </p>
        {isAdmin && onManageBilling && (
          <button
            type="button"
            onClick={onManageBilling}
            className="mt-1 inline-flex items-center gap-1 text-sm font-medium text-amber-800 underline hover:text-amber-950"
          >
            <svg {...STROKE} className="h-3.5 w-3.5">
              <path d="M15 3h6v6" />
              <path d="M10 14 21 3" />
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            </svg>
            Manage billing
          </button>
        )}
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="flex-shrink-0 rounded p-0.5 text-amber-600 hover:bg-amber-100 hover:text-amber-900"
          aria-label="Dismiss for today"
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
