import { useSyncExternalStore } from 'react'
import { createSoundEngine, getSoundSettings, subscribeSoundSettings } from '@toastmaster-timer/shared'
import { useEntitlement } from './useEntitlement'
import { useFlag } from './useFlag'

// One engine for the app: the player and the settings modal's test buttons
// share its AudioContext.
export const soundEngine = createSoundEngine()

/** The saved sound settings, live. */
export function useSoundSettings() {
  return useSyncExternalStore(subscribeSoundSettings, getSoundSettings, getSoundSettings)
}

/**
 * Whether sounds show at all (the release flag) and whether this user may turn
 * them on (Pro). A free user sees the controls, locked, with the way to Pro.
 *
 * @returns {{visible: boolean, usable: boolean}}
 */
export function useSoundsAccess() {
  const { enabled, known } = useFlag('sounds')
  const { isPro } = useEntitlement()
  const visible = known && enabled
  return { visible, usable: visible && isPro }
}
