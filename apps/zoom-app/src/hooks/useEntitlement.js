import { useSyncExternalStore } from 'react';
import { getEntitlement, isEntitlementKnown, subscribeEntitlement } from '@toastmaster-timer/shared';
import { useFlag } from './useFlag';

/**
 * The current user's plan, live.
 *
 * Reads the shared entitlement store so every component agrees, and re-renders
 * when the server's answer changes (on load, after a purchase, after a 402).
 *
 * `isPro` is the gate for every Pro feature in the UI, and needs the `pro`
 * release flag as well as the plan: while pro is dark nobody is Pro here, not
 * even a paying user or a club device. `known` waits for both answers, so a
 * Pro user never sees a lock flash while the flags are still on their way.
 * The server still keys on `entitled`; this decides only what the app offers.
 *
 * @returns {{entitlement: Object, known: boolean, isPro: boolean}}
 */
export function useEntitlement() {
  const entitlement = useSyncExternalStore(subscribeEntitlement, getEntitlement, getEntitlement);
  const entitlementKnown = useSyncExternalStore(subscribeEntitlement, isEntitlementKnown, isEntitlementKnown);
  const { enabled: proReleased, known: flagsKnown } = useFlag('pro');
  return {
    entitlement,
    known: entitlementKnown && flagsKnown,
    isPro: proReleased && entitlement.plan === 'pro',
  };
}
