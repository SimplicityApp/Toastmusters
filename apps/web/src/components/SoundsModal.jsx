import { Link } from 'react-router-dom'
import { X } from 'lucide-react'
import { updateSoundSettings } from '@toastmaster-timer/shared'
import { useEntitlement } from '../hooks/useEntitlement'
import { useFlag } from '../hooks/useFlag'
import { soundEngine, useSoundSettings, useSoundsAccess } from '../hooks/useSounds'
import { trackEvent } from '../utils/posthog'

const CUE_BUTTONS = [
  { color: 'green', label: 'Green', className: 'bg-green-500 hover:bg-green-600' },
  { color: 'yellow', label: 'Yellow', className: 'bg-yellow-400 hover:bg-yellow-500' },
  { color: 'red', label: 'Red', className: 'bg-red-500 hover:bg-red-600' },
]

/**
 * Sound settings (Pro): the card-change chime and its volume. Break music is
 * the Zoom app's; this timer has no Take a Break role.
 */
export default function SoundsModal({ isOpen, onClose }) {
  const settings = useSoundSettings()
  const { usable } = useSoundsAccess()
  const { known } = useEntitlement()
  // The account page sells Pro, and stays dark until pro is released.
  const { enabled: proEnabled, known: flagsKnown } = useFlag('pro')

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg p-6 w-full max-w-md max-h-full overflow-y-auto">
        <div className="flex justify-between items-center mb-1">
          <h3 className="text-lg font-semibold flex items-center gap-2">
            Sounds
            <span className="text-[10px] font-semibold uppercase tracking-wide text-blue-700 bg-blue-50 rounded px-1.5 py-0.5">
              Pro
            </span>
          </h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        <p className="text-sm text-gray-500 mb-4">
          For speakers who can&apos;t watch the card while they speak.
        </p>

        {!usable && (
          <p className="text-sm text-gray-700 bg-blue-50 border border-blue-100 rounded-lg p-3 mb-4">
            Sounds are part of Pro.
            {known && flagsKnown && proEnabled && (
              <>
                {' '}
                <Link to="/account" className="text-blue-600 hover:text-blue-700 underline">
                  Upgrade to Pro
                </Link>{' '}
                to turn them on.
              </>
            )}
          </p>
        )}

        <fieldset disabled={!usable} className={`space-y-4 ${usable ? '' : 'opacity-50'}`}>
          <div className="space-y-2">
            <label className="flex items-start gap-2.5 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.cues}
                onChange={(e) => {
                  const on = e.target.checked
                  updateSoundSettings({ cues: on })
                  trackEvent('sound_settings_changed', { setting: 'cues', value: on })
                }}
                className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 flex-shrink-0"
              />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-gray-900">Chime when the card changes</span>
                <span className="block text-xs text-gray-500">One soft note at green, two at yellow, three at red.</span>
              </span>
            </label>
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

          <label className="block">
            <span className="block text-sm font-medium text-gray-900 mb-1">Volume</span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={settings.volume}
              onChange={(e) => updateSoundSettings({ volume: Number(e.target.value) })}
              onPointerUp={() => soundEngine.playCue('green', settings.volume)}
              className="w-full"
              aria-label="Volume"
            />
          </label>
        </fieldset>

        <p className="text-xs text-gray-500 mt-4">
          Sounds play from this device. In person, the room hears them. On a video call, share your
          computer&apos;s sound so the speaker does.
        </p>
      </div>
    </div>
  )
}
