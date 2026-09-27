/**
 * The club's identity at the top of a timing report.
 *
 * The first component genuinely shared by both apps: it carries no Zoom SDK, no
 * timer context, and no storage, and it must look identical in the sidebar and
 * in the browser — a VP Education comparing the printout to the screenshot
 * someone pasted in the chat should not be able to tell which one came from
 * where.
 *
 * Stock Tailwind only, plus inline styles for the club's own colour. See
 * README.md: `bg-cream` and `font-display` exist in apps/web and not in
 * apps/zoom-app, and a class that is missing from one build fails silently.
 *
 * Renders nothing at all without a kit, so a free device's Report tab is
 * pixel-identical to what it was before any of this existed.
 */

const DATE_FORMAT = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' };

/** Up to two letters, for the placeholder mark a club without a logo gets. */
function initials(name) {
  return String(name ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join('');
}

/**
 * @param {Object} props
 * @param {string} props.clubName
 * @param {string} [props.primaryColor] - the club's hex colour
 * @param {string|null} [props.logoUrl] - public, immutable club asset URL
 * @param {Date|number|string} [props.date] - the meeting's date
 * @param {string} [props.label] - overrides "Timing report"
 */
export default function BrandedReportHeader({
  clubName,
  primaryColor = '#772432',
  logoUrl = null,
  date,
  label = 'Timing report',
}) {
  if (!clubName) return null;

  const when = date === undefined || date === null ? new Date() : new Date(date);
  const printed = Number.isNaN(when.getTime()) ? null : when.toLocaleDateString(undefined, DATE_FORMAT);

  return (
    <div
      className="rounded-lg overflow-hidden border border-gray-200 bg-white"
      data-testid="branded-report-header"
    >
      {/* The accent bar carries the club's colour even when the logo is a
          transparent PNG that reads as nothing against white. */}
      <div className="h-1.5" style={{ backgroundColor: primaryColor }} aria-hidden="true" />
      <div className="flex items-center gap-3 p-3">
        <div
          className="w-10 h-10 rounded-md flex items-center justify-center flex-shrink-0 overflow-hidden text-white font-bold text-sm"
          style={{ backgroundColor: primaryColor }}
        >
          {logoUrl ? (
            <img src={logoUrl} alt="" className="w-full h-full object-contain" />
          ) : (
            initials(clubName)
          )}
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-bold text-gray-900 truncate">{clubName}</p>
          {printed && (
            <p className="text-xs text-gray-500">
              {label} · {printed}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
