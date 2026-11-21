import { lazy, Suspense, useEffect, useId, useRef, useState } from 'react';
import { Check, Lock, Sparkles } from 'lucide-react';
import { isProLaunchBadgeDue, loadPromptState, subscribeToPromptState } from '@toastmaster-timer/shared';
import { useEntitlement } from '../hooks/useEntitlement';
import { useFlag } from '../hooks/useFlag';
import { trackEvent } from '../utils/posthog';
import { PRO_COMING_SOON_ITEMS, PRO_COMING_SOON_MORE } from '../components/ProComingSoon';
import { usePopover } from './usePopover';

const UpgradeModal = lazy(() => import('../components/UpgradeModal'));

const CHIP = 'relative flex h-8 flex-shrink-0 items-center gap-1 rounded-lg px-2.5 text-xs font-bold transition-colors';

/**
 * Before Pro is released: the chip greyed with a lock. Pointing at it or
 * pressing it lists what is coming, the same list the old footer button shows.
 * Nothing can be bought yet, so nothing here sells.
 */
function ProSoonChip() {
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const open = hovered || pinned;
  const wrapperRef = useRef(null);
  const trackedHover = useRef(false);
  const panelId = useId();

  usePopover(pinned, () => {
    setPinned(false);
    setHovered(false);
  }, [wrapperRef]);

  const handleEnter = () => {
    setHovered(true);
    if (!trackedHover.current) {
      trackedHover.current = true;
      trackEvent('pro_coming_soon_opened', { trigger: 'hover', surface: 'pro_chip' });
    }
  };

  const handleClick = () => {
    if (!pinned) trackEvent('pro_coming_soon_opened', { trigger: 'click', surface: 'pro_chip' });
    setPinned(!pinned);
  };

  return (
    <div ref={wrapperRef} className="relative" onMouseEnter={handleEnter} onMouseLeave={() => setHovered(false)}>
      <button
        type="button"
        onClick={handleClick}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label="Pro (coming soon)"
        className={`${CHIP} bg-slate-100 text-slate-500 hover:bg-slate-200`}
      >
        <Lock className="h-3.5 w-3.5" aria-hidden="true" />
        Pro
      </button>
      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label="Pro is coming soon"
          data-testid="pro-coming-soon"
          className="absolute right-0 top-full z-40 mt-2 w-64 rounded-lg border border-gray-200 bg-white p-3 text-left shadow-lg"
        >
          <p className="flex items-center gap-1.5 text-sm font-semibold text-gray-900">
            <Sparkles className="h-4 w-4 text-amber-500" aria-hidden="true" />
            Pro is coming soon
          </p>
          <ul className="mt-2 space-y-1.5">
            {PRO_COMING_SOON_ITEMS.map((item) => (
              <li key={item} className="flex gap-1.5 text-xs text-gray-700">
                <Check className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-green-600" aria-hidden="true" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-gray-500">{PRO_COMING_SOON_MORE}</p>
          <p className="mt-2 border-t border-gray-100 pt-2 text-xs text-gray-500">The timer itself stays free.</p>
        </div>
      )}
    </div>
  );
}

/**
 * The Pro chip beside the tabs, where the old footer's Upgrade / Pro button
 * went.
 *
 * - Flags not in yet: nothing, so no chip flashes and changes.
 * - `pro` off: locked, "coming soon".
 * - `pro` on, free plan: blue "Pro", with the red dot until the launch has
 *   been looked at. Opens the Upgrade dialog.
 * - `pro` on, Pro plan: amber "Pro". Opens the same dialog, which then
 *   manages the plan.
 */
export default function ProChip() {
  const { isPro, known } = useEntitlement();
  const { enabled: proEnabled, known: flagsKnown } = useFlag('pro');
  const [promptState, setPromptState] = useState(loadPromptState);
  const [showUpgrade, setShowUpgrade] = useState(false);
  useEffect(() => subscribeToPromptState(setPromptState), []);

  if (!flagsKnown) return null;
  if (!proEnabled) return <ProSoonChip />;
  if (!known) return null;

  const showDot = !isPro && isProLaunchBadgeDue(promptState);

  return (
    <>
      <button
        type="button"
        onClick={() => {
          trackEvent('pro_chip_clicked', { plan: isPro ? 'pro' : 'free', dot: showDot });
          setShowUpgrade(true);
        }}
        aria-label={isPro ? 'Manage your Pro plan' : 'Upgrade to Pro'}
        className={`${CHIP} ${isPro ? 'bg-amber-100 text-amber-800 hover:bg-amber-200' : 'bg-blue-50 text-blue-700 hover:bg-blue-100'}`}
      >
        <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
        Pro
        {showDot && (
          <>
            <span
              aria-hidden="true"
              data-testid="pro-new-dot"
              className="absolute right-[3px] top-[3px] h-[7px] w-[7px] rounded-full bg-red-500"
            />
            <span className="sr-only">New</span>
          </>
        )}
      </button>
      {showUpgrade && (
        <Suspense fallback={null}>
          <UpgradeModal isOpen={showUpgrade} onClose={() => setShowUpgrade(false)} source="pro_chip" />
        </Suspense>
      )}
    </>
  );
}
