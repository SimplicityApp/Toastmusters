import { useSyncExternalStore } from 'react'
import { getFlags, areFlagsKnown, subscribeFlags } from '@toastmaster-timer/shared'

/**
 * One release flag, live. Mirrors the Zoom app's hook of the same name.
 *
 * Shaped like useEntitlement so a gated control composes with the `known` gate
 * already beside it: render nothing until `known`, then only when `enabled`.
 * The key must be declared in worker/flags.js; worker/flags.test.js fails if
 * it is not.
 *
 * @param {string} key
 * @returns {{enabled: boolean, known: boolean}}
 */
export function useFlag(key) {
  const flags = useSyncExternalStore(subscribeFlags, getFlags, getFlags)
  const known = useSyncExternalStore(subscribeFlags, areFlagsKnown, areFlagsKnown)
  return { enabled: flags[key] === true, known }
}
