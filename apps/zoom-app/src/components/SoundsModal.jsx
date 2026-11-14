import { useEffect, useState, lazy, Suspense } from 'react';
import { X, Play, Square, Lock } from 'lucide-react';
import { BREAK_TRACKS, updateSoundSettings } from '@toastmaster-timer/shared';
import { useEntitlement } from '../hooks/useEntitlement';
import { useFlag } from '../hooks/useFlag';
import { SOUNDS_LOCK_MESSAGES, soundEngine, useSoundSettings, useSoundsAccess } from '../hooks/useSounds';
import { trackEvent } from '../utils/posthog';
const UpgradeModal = lazy(() => import('./UpgradeModal'));

const CUE_BUTTONS = [
  { color: 'green', label: 'Green', className: 'bg-green-500 hover:bg-green-600' },
  { color: 'yellow', label: 'Yellow', className: 'bg-yellow-400 hover:bg-yellow-500' },
  { color: 'red', label: 'Red', className: 'bg-red-500 hover:bg-red-600' },
];

function ToggleRow({ checked, onChange, title, description, locked }) {
  return (
    <label className={`flex items-start gap-2.5 ${locked ? 'cursor-not-allowed' : 'cursor-pointer'}`}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 flex-shrink-0"
      />
      <span className="min-w-0 flex-1">
        <span className={`flex items-center gap-1 text-sm font-medium ${locked ? 'text-gray-400' : 'text-gray-900'}`}>
          {title}
          {locked && <Lock className="h-3 w-3" aria-hidden="true" />}
        </span>
        <span className={`block text-xs ${locked ? 'text-gray-400' : 'text-gray-500'}`}>{description}</span>
      </span>
    </label>
  );
}

/**
 * Sound settings (Pro): the card-change chime, break music, and volume.
 * Opened only while the timer is stopped, so previewing music here never
 * fights a running break for the speakers.
 */
export default function SoundsModal({ isOpen, onClose }) {
  const settings = useSoundSettings();
  const { usable, lockReason } = useSoundsAccess();
  const { known } = useEntitlement();
  // The Upgrade link opens the purchase, which stays dark until pro is
  // released. Until then the note just says sounds are part of Pro.
  const { enabled: proEnabled, known: flagsKnown } = useFlag('pro');
  const [showUpgrade, setShowUpgrade] = useState(false);
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => () => soundEngine.stopMusic(), []);

  if (!isOpen) return null;

  const change = (setting, value) => {
    updateSoundSettings({ [setting]: value });
    (window.requestIdleCallback || setTimeout)(() => trackEvent('sound_settings_changed', { setting, value }));
  };

  const togglePreview = () => {
    if (previewing) {
      soundEngine.stopMusic();
      setPreviewing(false);
    } else {
      soundEngine.startMusic(settings.track, settings.volume);
      setPreviewing(true);
    }
  };

  const handleClose = () => {
    soundEngine.stopMusic();
    setPreviewing(false);
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg p-6 w-full max-w-md max-h-full overflow-y-auto">
        <div className="flex justify-between items-center mb-1">
          <h3 className="text-lg font-semibold flex items-center gap-2">
            Sounds
            {lockReason && <Lock className="h-4 w-4 text-gray-400" aria-label="Locked" />}
            <span className="text-[10px] font-semibold uppercase tracking-wide text-blue-700 bg-blue-50 rounded px-1.5 py-0.5">
              Pro
            </span>
          </h3>
          <button onClick={handleClose} className="text-gray-400 hover:text-gray-600" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        <p className="text-sm text-gray-500 mb-4">
          For speakers who can&apos;t watch the card while they speak, and for a livelier break.
        </p>

        {lockReason && (
          <p className="flex items-start gap-2 text-sm text-gray-700 bg-blue-50 border border-blue-100 rounded-lg p-3 mb-4">
            <Lock className="h-4 w-4 mt-0.5 flex-shrink-0 text-gray-500" aria-hidden="true" />
            <span>
              {lockReason === 'pro' ? 'Sounds are a Pro feature.' : SOUNDS_LOCK_MESSAGES.unreleased}
              {lockReason === 'pro' && known && flagsKnown && proEnabled && (
                <>
                  {' '}
                  <button
                    type="button"
                    onClick={() => setShowUpgrade(true)}
                    className="text-blue-600 hover:text-blue-700 underline"
                  >
                    Upgrade to Pro
                  </button>{' '}
                  to turn them on.
                </>
              )}
            </span>
          </p>
        )}

        {/* The tooltip sits on a wrapper: a disabled fieldset's controls get no
            hover events of their own in most browsers. */}
        <div data-tooltip={lockReason ? SOUNDS_LOCK_MESSAGES[lockReason] : undefined}>
          <fieldset disabled={!usable} className={`space-y-4 ${usable ? '' : 'opacity-50 cursor-not-allowed'}`}>
            <div className="space-y-2">
              <ToggleRow
                checked={settings.cues}
                onChange={(on) => change('cues', on)}
                title="Chime when the card changes"
                locked={!usable}
                description="One soft note at green, two at yellow, three at red."
              />
              <div className="flex items-center gap-2 pl-6">
                <span className="text-xs text-gray-500">Test:</span>
                {CUE_BUTTONS.map(({ color, label, className }) => (
                  <button
                    key={color}
                    type="button"
                    onClick={() => soundEngine.playCue(color, settings.volume)}
                    className={`px-2.5 py-1 rounded-md text-white text-xs font-medium transition-colors disabled:cursor-not-allowed ${className}`}
                    aria-label={`Play the ${label.toLowerCase()} chime`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <ToggleRow
                checked={settings.music}
                onChange={(on) => change('music', on)}
                title="Music during breaks"
                locked={!usable}
                description="Plays while Take a Break counts down, and stops at 00:00."
              />
              <div className="flex items-center gap-2 pl-6">
                {BREAK_TRACKS.length > 1 && (
                  <select
                    value={settings.track}
                    onChange={(e) => {
                      soundEngine.stopMusic();
                      setPreviewing(false);
                      change('track', e.target.value);
                    }}
                    className="text-sm border border-gray-300 rounded-md px-2 py-1"
                    aria-label="Break music"
                  >
                    {BREAK_TRACKS.map((track) => (
                      <option key={track.id} value={track.id}>
                        {track.label}
                      </option>
                    ))}
                  </select>
                )}
                <button
                  type="button"
                  onClick={togglePreview}
                  className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-gray-100 hover:bg-gray-200 text-gray-700 text-xs font-medium transition-colors"
                >
                  {previewing ? <Square className="h-3 w-3" /> : <Play className="h-3 w-3" />}
                  {previewing ? 'Stop' : 'Preview music'}
                </button>
              </div>
            </div>

            <label className="block">
              <span className="block text-sm font-medium text-gray-900 mb-1">Volume</span>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={settings.volume}
                onChange={(e) => {
                  const volume = Number(e.target.value);
                  updateSoundSettings({ volume });
                  soundEngine.setMusicVolume(volume);
                }}
                onPointerUp={() => !previewing && soundEngine.playCue('green', settings.volume)}
                className="w-full"
                aria-label="Volume"
              />
            </label>
          </fieldset>
        </div>

        <p className="text-xs text-gray-500 mt-4">
          Sounds play on this computer only. For the speaker to hear them, share your computer&apos;s
          sound in Zoom (Share Screen, then Share sound), or in a hybrid meeting play them through the
          room&apos;s speakers.
        </p>

        {showUpgrade && (
          <Suspense fallback={null}>
            <UpgradeModal isOpen={showUpgrade} onClose={() => setShowUpgrade(false)} source="sounds" />
          </Suspense>
        )}
      </div>
    </div>
  );
}
