import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { ClubGraceBanner } from '@toastmaster-timer/ui'
import { clubGraceReminder, dismissGraceReminder, loadClub, subscribeClub } from '@toastmaster-timer/shared'
import { trackEvent } from '../utils/posthog'
import { useFlag } from '../hooks/useFlag'

/**
 * The renewal reminder, wired to this browser's club.
 *
 * The banner itself is shared (`packages/ui`); only the wiring differs between
 * the two apps. Here "Manage billing" is a plain navigation — the browser can
 * simply go to Stripe and come back — where the Zoom app has to hand the URL to
 * the system browser instead.
 *
 * Renders nothing unless a club is inside its grace window.
 *
 * "Manage billing" is offered only once pro is known and on. While it
 * is off the portal answers 404, and this button would do nothing at all.
 */
export default function ClubStatusBanner() {
  const club = useSyncExternalStore(subscribeClub, loadClub, () => null)
  // Bumped by a dismissal so the memo below re-asks; the answer itself lives in
  // localStorage, which is what makes the reminder come back tomorrow.
  const [dismissals, setDismissals] = useState(0)
  const { enabled: proEnabled, known: flagsKnown } = useFlag('pro')
  const canOpenPortal = flagsKnown && proEnabled

  const reminder = useMemo(() => clubGraceReminder(), [club, dismissals])

  useEffect(() => {
    if (!reminder) return
    trackEvent('club_grace_banner_shown', {
      surface: 'web',
      club_id: reminder.clubId,
      days_left: reminder.daysLeft,
      is_admin: reminder.isAdmin,
    })
  }, [reminder?.clubId, reminder?.daysLeft, reminder?.isAdmin])

  if (!reminder) return null

  const handleManageBilling = async () => {
    trackEvent('billing_portal_opened', { source: 'club_grace_banner', club_id: reminder.clubId })
    const response = await fetch('/api/billing/portal', { method: 'POST', credentials: 'same-origin' })
    const body = await response.json().catch(() => ({}))
    if (response.ok && body.url) window.location.assign(body.url)
  }

  const handleDismiss = () => {
    dismissGraceReminder()
    setDismissals((count) => count + 1)
  }

  return (
    <ClubGraceBanner
      clubName={reminder.clubName || 'Your club'}
      daysLeft={reminder.daysLeft}
      isAdmin={reminder.isAdmin}
      onManageBilling={canOpenPortal ? handleManageBilling : undefined}
      onDismiss={handleDismiss}
    />
  )
}
