import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { AnnouncementBanner as Banner } from '@toastmaster-timer/ui';
import {
  areFlagsKnown,
  dismissAnnouncement,
  getFlags,
  pickAnnouncement,
  subscribeFlags,
} from '@toastmaster-timer/shared';
import { trackEvent } from '../utils/posthog';
import { openExternalUrl } from '../utils/zoomSdk';

/**
 * Whichever announcement applies now, above the tabs. What to announce lives
 * in ANNOUNCEMENTS (packages/shared/announcements.js); this only picks one for
 * the Zoom app, remembers a close, and opens a link in the system browser,
 * since Zoom's webview does not leave the app.
 *
 * Renders nothing when no announcement applies, so the app is unchanged.
 *
 * @param {{announcements?: ReadonlyArray<Object>}} props - a list for tests;
 *   the app uses the shipped one
 */
export default function AnnouncementBanner({ announcements } = {}) {
  const flags = useSyncExternalStore(subscribeFlags, getFlags, getFlags);
  const flagsKnown = useSyncExternalStore(subscribeFlags, areFlagsKnown, areFlagsKnown);
  // Bumped by a close so the memo below asks again; the answer itself lives
  // in localStorage.
  const [dismissals, setDismissals] = useState(0);
  const [closedHere, setClosedHere] = useState(null);

  const announcement = useMemo(
    () => pickAnnouncement({ surface: 'zoom', flags, flagsKnown, announcements }),
    [flags, flagsKnown, announcements, dismissals],
  );
  const id = announcement?.id ?? null;

  useEffect(() => {
    if (id) trackEvent('announcement_shown', { surface: 'zoom', announcement_id: id });
  }, [id]);

  // Storage that refuses the write still hides it until the app reopens.
  if (!announcement || announcement.id === closedHere) return null;

  const handleDismiss = () => {
    dismissAnnouncement(announcement.id);
    trackEvent('announcement_dismissed', { surface: 'zoom', announcement_id: announcement.id });
    setClosedHere(announcement.id);
    setDismissals((count) => count + 1);
  };

  const handleLink = announcement.link?.url
    ? () => {
        trackEvent('announcement_link_opened', { surface: 'zoom', announcement_id: announcement.id });
        openExternalUrl(announcement.link.url);
      }
    : undefined;

  return (
    <Banner
      id={announcement.id}
      lead={announcement.lead}
      text={announcement.text}
      tone={announcement.tone}
      linkLabel={announcement.link?.label}
      onLink={handleLink}
      onDismiss={handleDismiss}
    />
  );
}
