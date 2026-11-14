import { useSyncExternalStore } from 'react';
import { createSoundEngine, getSoundSettings, subscribeSoundSettings } from '@toastmaster-timer/shared';
import { useEntitlement } from './useEntitlement';
import { useFlag } from './useFlag';

// One engine for the app: the player and the settings modal's test buttons
// share its AudioContext, and only one break track can be playing.
export const soundEngine = createSoundEngine({
  resolveTrackUrl: (file) => `${import.meta.env.BASE_URL}music/${file}`,
});

/** The saved sound settings, live. */
export function useSoundSettings() {
  return useSyncExternalStore(subscribeSoundSettings, getSoundSettings, getSoundSettings);
}

// The lock tooltip on the Sounds button, its modal, and the modal's controls.
export const SOUNDS_LOCK_MESSAGES = Object.freeze({
  pro: 'Sounds are a Pro feature. Upgrade to Pro to use them.',
  unreleased: 'Hold tight! Sounds are coming soon.',
});

/**
 * Whether this user may turn sounds on: the release flag and Pro both. The
 * button and modal always show, so everyone can see what is on the way; anyone
 * who cannot use them gets them locked, with lockReason saying why. 'pro' only
 * when buying Pro would unlock them, which needs both `sounds` and `pro`
 * released. While either is off, Pro cannot get them, so the lock says they are
 * coming rather than selling a plan that cannot be bought yet. Until both
 * answers are in, sounds are unusable but not yet locked, so a Pro user never
 * sees a lock flash on load.
 *
 * @returns {{usable: boolean, lockReason: 'pro'|'unreleased'|null}}
 */
export function useSoundsAccess() {
  const { enabled: soundsReleased, known: flagsKnown } = useFlag('sounds');
  const { enabled: proReleased } = useFlag('pro');
  const { isPro, known: entitlementKnown } = useEntitlement();
  const usable = flagsKnown && soundsReleased && isPro;
  let lockReason = null;
  if (flagsKnown && entitlementKnown && !usable) {
    lockReason = soundsReleased && proReleased ? 'pro' : 'unreleased';
  }
  return { usable, lockReason };
}
