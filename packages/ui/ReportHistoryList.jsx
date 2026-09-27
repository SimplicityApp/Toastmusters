/**
 * The club's meetings, newest first.
 *
 * Presentational, like everything else in this package: it is handed the list
 * the archive returned and knows nothing about how it got here. Stock Tailwind
 * only, plus inline styles for the club's own colour — see README.md, because
 * `bg-cream` and `font-display` exist in apps/web and not in apps/zoom-app and
 * a class missing from one build fails silently.
 *
 * It has to read in a 280px Zoom sidebar as well as on a laptop, so every row
 * is one line of identity and one line of counts rather than a table.
 */

const DATE_FORMAT = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' };

/** `2026-09-29` → `Tue, 29 Sep 2026`, in whatever locale the reader is in. */
function readableDate(value) {
  if (!value) return null;
  const when = new Date(`${value}T12:00:00`);
  return Number.isNaN(when.getTime()) ? value : when.toLocaleDateString(undefined, DATE_FORMAT);
}

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

/**
 * @param {Object} props
 * @param {Array<{meetingId: string, date: string|null, title: string|null,
 *   speeches: number, overtime: number, live?: boolean}>} props.meetings
 * @param {boolean} [props.loading]
 * @param {string|null} [props.error] - a line of copy, already written
 * @param {(meetingId: string) => void} [props.onSelect]
 * @param {string} [props.primaryColor] - the club's hex colour
 * @param {string} [props.emptyMessage]
 */
export default function ReportHistoryList({
  meetings = [],
  loading = false,
  error = null,
  onSelect,
  primaryColor = '#772432',
  emptyMessage = 'No meetings saved yet. Finished speeches are saved here automatically.',
}) {
  if (loading) {
    return (
      <p className="text-center text-sm text-gray-500 py-8" data-testid="report-history-loading">
        Loading the club’s meetings…
      </p>
    );
  }

  if (error) {
    return (
      <p className="text-center text-sm text-gray-500 py-8" data-testid="report-history-error">
        {error}
      </p>
    );
  }

  if (!meetings.length) {
    return (
      <p className="text-center text-sm text-gray-500 py-8" data-testid="report-history-empty">
        {emptyMessage}
      </p>
    );
  }

  const totalSpeeches = meetings.reduce((sum, meeting) => sum + (meeting.speeches ?? 0), 0);

  return (
    <div data-testid="report-history-list">
      {/* The summary strip: what the club has actually banked, in one line. */}
      <p className="text-xs text-gray-500 mb-2">
        {plural(meetings.length, 'meeting', 'meetings')} · {plural(totalSpeeches, 'speech', 'speeches')}
      </p>
      <ul className="space-y-2">
        {meetings.map((meeting) => {
          const label = meeting.title || readableDate(meeting.date) || meeting.meetingId;
          const Row = onSelect ? 'button' : 'div';
          return (
            <li key={meeting.meetingId}>
              <Row
                {...(onSelect
                  ? { type: 'button', onClick: () => onSelect(meeting.meetingId) }
                  : {})}
                data-testid={`meeting-${meeting.meetingId}`}
                className={`w-full text-left rounded-lg border border-gray-200 bg-white p-3 flex items-center gap-3 ${
                  onSelect ? 'hover:bg-gray-50' : ''
                }`}
              >
                <span
                  className="w-1 self-stretch rounded-full flex-shrink-0"
                  style={{ backgroundColor: primaryColor }}
                  aria-hidden="true"
                />
                <span className="flex-1 min-w-0">
                  <span className="block font-semibold text-gray-900 truncate">{label}</span>
                  <span className="block text-xs text-gray-500">
                    {meeting.title && readableDate(meeting.date) ? `${readableDate(meeting.date)} · ` : ''}
                    {plural(meeting.speeches ?? 0, 'speech', 'speeches')}
                    {meeting.overtime > 0 ? ` · ${meeting.overtime} over time` : ''}
                  </span>
                </span>
                {meeting.live && (
                  // The evening in progress. Worth saying, because its counts
                  // are still moving and a second device is probably adding to
                  // them right now.
                  <span className="text-xs font-semibold text-gray-500 uppercase flex-shrink-0">In progress</span>
                )}
              </Row>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
