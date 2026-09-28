import { Users } from 'lucide-react';

/**
 * Which timing list the rules editor is showing, and the one control that
 * moves between them.
 *
 * A club device is on one list or the other, never a blend, so the banner's
 * whole job is to answer "which one am I looking at" before anyone edits
 * anything. It renders only when there is a second list to choose from.
 *
 * @param {Object} props
 * @param {string} props.clubName
 * @param {'club'|'personal'} props.source
 * @param {() => void} props.onUseClub
 * @param {() => void} props.onUseMine
 * @param {() => void} props.onResetToClub - clears this device's copy as well
 */
export default function ClubPresetBanner({ clubName, source, onUseClub, onUseMine, onResetToClub }) {
  const onClub = source === 'club';
  const tab = (active) =>
    `px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
      active ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'
    }`;

  return (
    <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex gap-2">
          <Users className="h-4 w-4 text-blue-600 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-gray-900">
              {onClub ? `${clubName} presets` : 'My presets'}
            </p>
            <p className="text-xs text-gray-600 mt-0.5">
              {onClub
                ? `Set by your club admin. Editing these makes your own copy on this device.`
                : `Your own timings on this device. ${clubName}'s list is one tap away.`}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1 bg-blue-100 rounded-lg p-0.5 flex-shrink-0" role="group" aria-label="Which presets to use">
          <button type="button" onClick={onUseClub} className={tab(onClub)} aria-pressed={onClub}>
            {clubName}
          </button>
          <button type="button" onClick={onUseMine} className={tab(!onClub)} aria-pressed={!onClub}>
            Mine
          </button>
        </div>
      </div>

      {!onClub && (
        <button
          type="button"
          onClick={onResetToClub}
          className="mt-2 text-xs font-medium text-blue-700 hover:text-blue-900"
        >
          Reset to club
        </button>
      )}
    </div>
  );
}
