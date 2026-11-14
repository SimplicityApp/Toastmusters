import { useEffect, useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import { useFlag } from '../hooks/useFlag';
import { trackEvent } from '../utils/posthog';

export const LAUNCH_TEASER_DISMISSED_KEY = 'toastmaster_launch_teaser_dismissed';

function wasDismissed() {
  try {
    return localStorage.getItem(LAUNCH_TEASER_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * A heads-up before the launch: a new look for the app and Pro are on the way.
 *
 * Shown only once the flags are known and `pro` is off, so it never flashes on
 * load and it retires itself the moment Pro is released: from then on the
 * launch announcement speaks instead. One dismissal hides it on this device for
 * good. A plain line with no button to act on, because nothing can be bought
 * or tried yet.
 */
export default function LaunchTeaserBanner() {
  const { enabled: proReleased, known: flagsKnown } = useFlag('pro');
  const [dismissed, setDismissed] = useState(wasDismissed);
  const visible = flagsKnown && !proReleased && !dismissed;

  useEffect(() => {
    if (visible) trackEvent('launch_teaser_banner_shown', { surface: 'zoom' });
  }, [visible]);

  if (!visible) return null;

  const handleDismiss = () => {
    try {
      localStorage.setItem(LAUNCH_TEASER_DISMISSED_KEY, '1');
    } catch {
      // Storage refused: it still goes away until the app is reopened.
    }
    trackEvent('launch_teaser_banner_dismissed', { surface: 'zoom' });
    setDismissed(true);
  };

  return (
    <div
      role="status"
      data-testid="launch-teaser-banner"
      className="flex items-center gap-2 border-b border-blue-100 bg-blue-50 px-3 py-2"
    >
      <Sparkles className="h-4 w-4 flex-shrink-0 text-blue-600" aria-hidden="true" />
      <p className="min-w-0 flex-1 text-sm text-blue-900">
        <span className="font-semibold">Coming soon:</span> a fresh new look for the timer, and Pro
        features for your club.
      </p>
      <button
        type="button"
        onClick={handleDismiss}
        aria-label="Dismiss"
        className="flex-shrink-0 rounded p-1 text-blue-700 hover:bg-blue-100 hover:text-blue-900"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
