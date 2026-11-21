import { lazy, Suspense, useRef, useState } from 'react';
import { Eraser, KeyRound, MessageSquare, MoreHorizontal, PlayCircle, SlidersHorizontal, Star } from 'lucide-react';
import {
  FEEDBACK_SURVEY_ID,
  REVIEW_PROMPT,
  REVIEW_SURVEY_ID,
  TUTORIALS_URL,
  ZOOM_MARKETPLACE_REVIEW_URL,
  markPromptAnswered,
} from '@toastmaster-timer/shared';
import { useEntitlement } from '../hooks/useEntitlement';
import { useFlag } from '../hooks/useFlag';
import { useClub } from '../hooks/useClub';
import { useToast } from '../context/ToastContext';
import { openExternalUrl } from '../utils/zoomSdk';
import { trackEvent } from '../utils/posthog';
import { moveFocusWithArrows, usePopover } from './usePopover';

const FeedbackModal = lazy(() => import('../components/FeedbackModal'));
const UpgradeModal = lazy(() => import('../components/UpgradeModal'));

const ITEM =
  'flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm text-gray-900 hover:bg-slate-50 focus:bg-slate-50 focus:outline-none';
const ICON = 'h-4 w-4 flex-shrink-0 text-slate-500';

const idle = (fn) => (window.requestIdleCallback || setTimeout)(fn);

/**
 * The ⋯ menu at the end of the top bar: everything that used to sit in the
 * footer or around the timer but is not needed during a speech.
 *
 * Your plan and the club code appear only once Pro is released, like every
 * other door into Pro. "Clear the timer from my video" and "Roles & timing
 * rules" are handed to the shell, which owns the Timer tab and the rules
 * dialog; the rest (feedback, the review link, the tutorials) are handled
 * here.
 *
 * @param {{onClearVideo: () => void, onOpenRules: () => void}} props
 */
export default function MoreMenu({ onClearVideo, onOpenRules }) {
  const [open, setOpen] = useState(false);
  const [upgradeSource, setUpgradeSource] = useState(null);
  const [showFeedback, setShowFeedback] = useState(false);
  const buttonRef = useRef(null);
  const menuRef = useRef(null);
  const { showToast } = useToast();
  const { isPro, known } = useEntitlement();
  const { enabled: proEnabled, known: flagsKnown } = useFlag('pro');
  const { club } = useClub();
  const proOn = flagsKnown && proEnabled && known;

  const close = () => setOpen(false);
  usePopover(open, close, [buttonRef, menuRef]);

  const openMenu = () => {
    setOpen(true);
    idle(() => trackEvent('more_menu_opened'));
    // Focus the first item once it is drawn, so arrows work straight away.
    setTimeout(() => menuRef.current?.querySelector('[role="menuitem"]')?.focus(), 0);
  };

  const choose = (action) => () => {
    close();
    buttonRef.current?.focus();
    action();
  };

  const handleFeedback = () => {
    idle(() => {
      trackEvent('feedback_button_clicked', { source: 'more_menu' });
      trackEvent('survey shown', { $survey_id: FEEDBACK_SURVEY_ID });
    });
    setShowFeedback(true);
  };

  // As the old footer's Review button: the periodic ask retires only once the
  // listing actually opened.
  const handleRate = async () => {
    trackEvent('review_prompt_accepted', { destination: 'zoom_marketplace', source: 'more_menu' });
    if (!(await openExternalUrl(ZOOM_MARKETPLACE_REVIEW_URL))) {
      trackEvent('review_link_failed', { destination: 'zoom_marketplace', source: 'more_menu' });
      showToast('Could not open the browser. Search "Toastmaster Timer" in the Zoom App Marketplace.', 'error', 6000);
      return;
    }
    if (REVIEW_SURVEY_ID) {
      trackEvent('survey sent', {
        $survey_id: REVIEW_SURVEY_ID,
        $survey_response: 'opened_zoom_marketplace_review',
        $survey_response_0: 'opened_zoom_marketplace_review',
      });
    }
    markPromptAnswered(REVIEW_PROMPT);
  };

  const handleTutorials = async () => {
    idle(() => trackEvent('tutorials_opened', { source: 'more_menu' }));
    if (!(await openExternalUrl(TUTORIALS_URL))) {
      showToast('Could not open the browser. The videos are at toastmusters.com/tutorials.', 'error', 6000);
    }
  };

  return (
    <div className="relative flex-shrink-0">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => (open ? close() : openMenu())}
        aria-label="More"
        aria-haspopup="menu"
        aria-expanded={open}
        className={`flex h-8 w-8 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100 ${open ? 'bg-slate-200' : ''}`}
      >
        <MoreHorizontal className="h-[18px] w-[18px]" aria-hidden="true" />
      </button>

      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="More"
          onKeyDown={(event) => moveFocusWithArrows(event, menuRef.current, '[role="menuitem"]')}
          className="absolute right-0 top-full z-40 mt-1.5 w-[262px] overflow-hidden rounded-xl border border-gray-200 bg-white py-1 shadow-[0_12px_28px_rgba(15,23,42,0.22)]"
        >
          {proOn && (
            <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-2.5">
              <span className="min-w-0 flex-1 text-sm">
                <span className="block text-xs text-slate-500">Your plan</span>
                <strong className="text-gray-900">{isPro ? 'Pro' : 'Free'}</strong>
              </span>
              <button
                type="button"
                role="menuitem"
                onClick={choose(() => setUpgradeSource('more_plan'))}
                className="rounded-lg bg-blue-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-blue-700"
              >
                {isPro ? 'Manage' : 'See Pro'}
              </button>
            </div>
          )}
          {proOn && !club && (
            <button type="button" role="menuitem" className={ITEM} onClick={choose(() => setUpgradeSource('more_join_club'))}>
              <KeyRound className={ICON} aria-hidden="true" />
              Join my club with a code
            </button>
          )}
          <button type="button" role="menuitem" className={ITEM} onClick={choose(onOpenRules)}>
            <SlidersHorizontal className={ICON} aria-hidden="true" />
            Roles &amp; timing rules
          </button>
          <button type="button" role="menuitem" className={ITEM} onClick={choose(onClearVideo)}>
            <Eraser className={ICON} aria-hidden="true" />
            Clear the timer from my video
          </button>
          <div className="my-1 border-t border-slate-100" role="separator" />
          <button type="button" role="menuitem" className={ITEM} onClick={choose(handleTutorials)}>
            <PlayCircle className={ICON} aria-hidden="true" />
            How-to videos
          </button>
          <button type="button" role="menuitem" className={ITEM} onClick={choose(handleFeedback)}>
            <MessageSquare className={ICON} aria-hidden="true" />
            Send feedback
          </button>
          <button type="button" role="menuitem" className={ITEM} onClick={choose(handleRate)}>
            <Star className={ICON} aria-hidden="true" />
            Rate the app
          </button>
        </div>
      )}

      {upgradeSource && (
        <Suspense fallback={null}>
          <UpgradeModal isOpen onClose={() => setUpgradeSource(null)} source={upgradeSource} />
        </Suspense>
      )}
      {showFeedback && (
        <Suspense fallback={null}>
          <FeedbackModal isOpen={showFeedback} onClose={() => setShowFeedback(false)} />
        </Suspense>
      )}
    </div>
  );
}
