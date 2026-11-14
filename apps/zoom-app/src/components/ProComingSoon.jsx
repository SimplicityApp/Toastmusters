import { useEffect, useId, useRef, useState } from 'react';
import { Check, Lock, Sparkles } from 'lucide-react';
import { trackEvent } from '../utils/posthog';

// What Pro will bring, in a few words each. Keep it short: it opens in the
// footer of a 400px side panel.
export const PRO_COMING_SOON_ITEMS = Object.freeze([
  'Sounds: a chime at each colour, music for breaks',
  "Your club's card sets on every club timer",
  'Voting for Best Table Topics and Best Evaluator',
]);
export const PRO_COMING_SOON_MORE = "And more: your club's logo, shared timings, meeting history.";

/**
 * The footer's Pro button before Pro is released: greyed, with a lock. Pointing
 * at it or clicking it opens a short list of what is coming. A click keeps the
 * list open until the next click, Escape or a click elsewhere, so it works
 * without a mouse too.
 */
export default function ProComingSoon() {
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const open = hovered || pinned;
  const wrapperRef = useRef(null);
  const trackedHover = useRef(false);
  const panelId = useId();

  useEffect(() => {
    if (!pinned) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape') {
        setPinned(false);
        setHovered(false);
      }
    };
    const onPointer = (event) => {
      if (!wrapperRef.current?.contains(event.target)) setPinned(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointer);
    };
  }, [pinned]);

  const handleEnter = () => {
    setHovered(true);
    if (!trackedHover.current) {
      trackedHover.current = true;
      trackEvent('pro_coming_soon_opened', { trigger: 'hover' });
    }
  };

  const handleClick = () => {
    if (!pinned) trackEvent('pro_coming_soon_opened', { trigger: 'click' });
    setPinned(!pinned);
  };

  return (
    <div
      ref={wrapperRef}
      className="relative"
      onMouseEnter={handleEnter}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        onClick={handleClick}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label="Pro (coming soon)"
        className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-400 hover:text-gray-500 hover:bg-gray-50 rounded-md transition-colors duration-150"
      >
        <Sparkles className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
        <span>Pro</span>
        <Lock className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
      </button>
      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label="Pro is coming soon"
          data-testid="pro-coming-soon"
          className="absolute bottom-full right-0 z-40 mb-2 w-64 rounded-lg border border-gray-200 bg-white p-3 text-left shadow-lg"
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
