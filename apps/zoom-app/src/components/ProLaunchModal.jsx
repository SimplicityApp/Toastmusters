import { lazy, Suspense, useState } from 'react';
import { X, Sparkles } from 'lucide-react';
import { useFlag } from '../hooks/useFlag';
import { trackEvent } from '../utils/posthog';

const UpgradeModal = lazy(() => import('./UpgradeModal'));

/**
 * The one-time "Pro is here" announcement, shown by PeriodicPrompts after a
 * speech ends, never on its own and never before START: the Upgrade dialog's
 * rule that nothing stands between a timer and the START button still holds.
 *
 * It only says what Pro is for and hands off. Buying, and joining a club with a
 * code, stay in UpgradeModal, which opens in its place; opening it marks the
 * announcement answered there, so this modal has no answered path of its own.
 * Closing it (X or "Not now") counts as the one ask it gets.
 */
export default function ProLaunchModal({ isOpen, onAnswered, onDismiss }) {
  const [showUpgrade, setShowUpgrade] = useState(false);
  // Sounds are only pitched once they are released: while `sounds` is off a
  // Pro user would find them locked as "coming soon".
  const { enabled: soundsReleased } = useFlag('sounds');

  if (!isOpen) return null;

  if (showUpgrade) {
    return (
      <Suspense fallback={null}>
        <UpgradeModal isOpen onClose={onAnswered} source="pro_launch" />
      </Suspense>
    );
  }

  const handleLearnMore = () => {
    trackEvent('pro_launch_learn_more');
    setShowUpgrade(true);
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="pro-launch-title"
        className="bg-white rounded-lg p-6 w-full max-w-md"
      >
        <div className="flex justify-between items-start mb-3">
          <h3 id="pro-launch-title" className="text-lg font-semibold flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-blue-600 flex-shrink-0" />
            New: Pro for your club
          </h3>
          <button
            onClick={onDismiss}
            className="text-gray-400 hover:text-gray-600 flex-shrink-0"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* The club is the buyer, and the timer role rotates weekly: the copy
            speaks to the whole club so whoever is timing can pass it on. */}
        <p className="text-sm text-gray-600 mb-3">
          One plan covers every timer in your club:
        </p>
        <ul className="text-sm text-gray-700 space-y-1.5 mb-3 list-disc pl-5">
          <li>Your club&apos;s brand kit on every timer card and report</li>
          <li>Shared timing presets, set once for every timer</li>
          <li>Every meeting saved to your club&apos;s archive</li>
          {soundsReleased && <li>A chime when the card changes, and music during breaks</li>}
        </ul>
        <p className="text-sm text-gray-600 mb-5">
          The timer itself stays free. Not the one who decides? Tell your club officers.
        </p>

        <div className="flex gap-2 justify-end">
          <button
            onClick={onDismiss}
            className="px-4 py-2 bg-gray-300 hover:bg-gray-400 text-gray-800 font-semibold rounded-lg transition-colors text-sm"
          >
            Not now
          </button>
          <button
            onClick={handleLearnMore}
            className="flex items-center gap-2 px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white font-semibold rounded-lg transition-colors text-sm"
          >
            See what&apos;s in Pro
          </button>
        </div>
      </div>
    </div>
  );
}
