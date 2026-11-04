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

// The lock tooltip on the Sounds button, its modal, and the modal's controls.
export const SOUNDS_LOCK_MESSAGES = Object.freeze({
  pro: 'Sounds are a Pro feature. Upgrade to Pro to use them.',
  unreleased: 'Sounds are coming soon.',
})

/**
 * Whether this user may turn sounds on: the release flag and Pro both. The
 * button and modal always show, so free users can see what Pro adds; anyone
 * who cannot use them gets them locked, with lockReason saying why. Until both
 * answers are in, sounds are unusable but not yet locked, so a Pro user never
 * sees a lock flash on load.
 *
 * @returns {{usable: boolean, lockReason: 'pro'|'unreleased'|null}}
 */
export function useSoundsAccess() {
  const { enabled, known: flagsKnown } = useFlag('sounds')
  const { isPro, known: entitlementKnown } = useEntitlement()
  const usable = flagsKnown && enabled && isPro
  let lockReason = null
  if (flagsKnown && entitlementKnown && !usable) lockReason = isPro ? 'unreleased' : 'pro'
  return { usable, lockReason }
}
