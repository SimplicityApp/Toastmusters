import { useEffect, useState, useSyncExternalStore } from 'react'
import { getEntitlement, isEntitlementKnown, subscribeEntitlement } from '@toastmaster-timer/shared'
import { resolveWebIdentity } from '../utils/webIdentity'
import { useFlag } from './useFlag'

/**
 * The current plan, live. Mirrors the Zoom app's hook of the same name: `isPro`
 * needs the `pro` release flag as well as the plan, so while pro is dark nobody
 * is Pro in the UI, and `known` waits for both answers.
 */
export function useEntitlement() {
  const entitlement = useSyncExternalStore(subscribeEntitlement, getEntitlement, getEntitlement)
  const entitlementKnown = useSyncExternalStore(subscribeEntitlement, isEntitlementKnown, isEntitlementKnown)
  const { enabled: proReleased, known: flagsKnown } = useFlag('pro')
  return {
    entitlement,
    known: entitlementKnown && flagsKnown,
    isPro: proReleased && entitlement.plan === 'pro',
  }
}

/**
 * Whether the visitor is signed in. `null` until the Worker has answered, so
 * a header can avoid flashing "Sign in" at someone who is.
 *
 * @returns {{identified: boolean, uid: string|null}|null}
 */
export function useWebIdentity() {
  const [identity, setIdentity] = useState(null)
  useEffect(() => {
    let cancelled = false
    resolveWebIdentity().then((result) => {
      if (!cancelled) setIdentity(result)
    })
    return () => {
      cancelled = true
    }
  }, [])
  return identity
}
