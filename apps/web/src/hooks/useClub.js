import { useSyncExternalStore } from 'react';
import { loadClub, subscribeClub, clubKit, subscribeOutbox, outboxCount } from '@toastmaster-timer/shared';

/**
 * The club this device joined, live.
 *
 * Reads the shared club cache so every component agrees, and re-renders when
 * the daily refresh, an activation, or a "leave" changes it. The same shape as
 * `useEntitlement`, and for the same reason: the cache is a module-level store
 * and React needs to be told when it moves.
 *
 * @returns {{club: Object|null, kit: Object|null, clubName: string|null}}
 */
export function useClub() {
  const club = useSyncExternalStore(subscribeClub, loadClub, loadClub);
  // Derived rather than stored: a lapsed club still has a cached record — the
  // device keeps knowing which club to check — but it has no kit to render.
  const kit = club ? clubKit() : null;
  return { club, kit, clubName: kit?.name ?? null };
}

/**
 * Whether this device still has speeches the club has not received.
 *
 * Backs the "Saved to <club>" indicator, which reads outbox emptiness rather
 * than the last request's result — so a device that went offline mid-meeting
 * shows work pending instead of claiming success.
 *
 * @returns {number} how many speeches are still queued
 */
export function useOutboxPending() {
  return useSyncExternalStore(subscribeOutbox, outboxCount, outboxCount);
}
