import { useEffect, useState, useSyncExternalStore } from 'react'
import { getEntitlement, isEntitlementKnown, subscribeEntitlement } from '@toastmaster-timer/shared'
import { resolveWebIdentity } from '../utils/webIdentity'

/** The current plan, live. Mirrors the Zoom app's hook of the same name. */
export function useEntitlement() {
  const entitlement = useSyncExternalStore(subscribeEntitlement, getEntitlement, getEntitlement)
  const known = useSyncExternalStore(subscribeEntitlement, isEntitlementKnown, isEntitlementKnown)
  return { entitlement, known, isPro: entitlement.plan === 'pro' }
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
