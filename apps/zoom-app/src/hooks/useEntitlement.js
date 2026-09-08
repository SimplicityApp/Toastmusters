import { useSyncExternalStore } from 'react';
import { getEntitlement, isEntitlementKnown, subscribeEntitlement } from '@toastmaster-timer/shared';

/**
 * The current user's plan, live.
 *
 * Reads the shared entitlement store so every component agrees, and re-renders
 * when the server's answer changes (on load, after a purchase, after a 402).
 *
 * @returns {{entitlement: Object, known: boolean, isPro: boolean}}
 */
export function useEntitlement() {
  const entitlement = useSyncExternalStore(subscribeEntitlement, getEntitlement, getEntitlement);
  const known = useSyncExternalStore(subscribeEntitlement, isEntitlementKnown, isEntitlementKnown);
  return { entitlement, known, isPro: entitlement.plan === 'pro' };
}
