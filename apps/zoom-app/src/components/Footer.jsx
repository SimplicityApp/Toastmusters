import { useState, lazy, Suspense, memo } from 'react';
import { MessageSquare, Star, Sparkles } from 'lucide-react';
import { useEntitlement } from '../hooks/useEntitlement';
import {
  FEEDBACK_SURVEY_ID,
  REVIEW_PROMPT,
  REVIEW_SURVEY_ID,
  ZOOM_MARKETPLACE_REVIEW_URL,
  markPromptAnswered,
} from '@toastmaster-timer/shared';
import { trackEvent } from '../utils/posthog';
import { openExternalUrl } from '../utils/zoomSdk';
import { useToast } from '../context/ToastContext';
const FeedbackModal = lazy(() => import('./FeedbackModal'));
const UpgradeModal = lazy(() => import('./UpgradeModal'));

export default memo(function Footer() {
  const { showToast } = useToast();
  const [showFeedbackModal, setShowFeedbackModal] = useState(false);
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);
  const { isPro, known } = useEntitlement();

  const handleFeedbackClick = () => {
    (window.requestIdleCallback || setTimeout)(() => {
      trackEvent('feedback_button_clicked');
      trackEvent('survey shown', { $survey_id: FEEDBACK_SURVEY_ID });
    });
    setShowFeedbackModal(true);
  };

  // Someone who reviews of their own accord should never see the periodic ask —
  // but only once the listing actually opened, since a client that refused the
  // openUrl capability would otherwise retire the ask for nothing.
  const handleReviewClick = async () => {
    trackEvent('review_prompt_accepted', {
      destination: 'zoom_marketplace',
      source: 'footer',
    });

    if (!(await openExternalUrl(ZOOM_MARKETPLACE_REVIEW_URL))) {
      trackEvent('review_link_failed', { destination: 'zoom_marketplace', source: 'footer' });
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

  return (
    <>
      {/* Labels stay short: this panel is 400px wide in the Zoom client. */}
      <footer className="w-full border-t border-gray-200 bg-white px-2 py-2 flex items-center justify-center gap-1">
        <button
          id="feedback-button"
          onClick={handleFeedbackClick}
          className="flex items-center gap-2 px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-50 rounded-md transition-colors duration-150"
          aria-label="Provide feedback or request features"
        >
          <MessageSquare className="w-4 h-4 flex-shrink-0" />
          <span>Send Us Feedback</span>
        </button>
        <button
          onClick={handleReviewClick}
          className="flex items-center gap-2 px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-50 rounded-md transition-colors duration-150"
          aria-label="Leave a review on the Zoom App Marketplace"
        >
          <Star className="w-4 h-4 flex-shrink-0" />
          <span>Review</span>
        </button>
        {/* Hidden until the server has said which plan this is, so a Pro user
            never sees "Upgrade" flash before the answer lands. */}
        {known && (
          <button
            onClick={() => setShowUpgradeModal(true)}
            className={`flex items-center gap-2 px-3 py-1.5 text-sm rounded-md transition-colors duration-150 ${
              isPro ? 'text-amber-600 hover:bg-amber-50' : 'text-blue-600 hover:text-blue-700 hover:bg-blue-50 font-medium'
            }`}
            aria-label={isPro ? 'Manage your Pro plan' : 'Upgrade to Pro'}
          >
            <Sparkles className="w-4 h-4 flex-shrink-0" />
            <span>{isPro ? 'Pro' : 'Upgrade'}</span>
          </button>
        )}
      </footer>
      {showUpgradeModal && (
        <Suspense fallback={null}>
          <UpgradeModal isOpen={showUpgradeModal} onClose={() => setShowUpgradeModal(false)} source="footer" />
        </Suspense>
      )}
      {showFeedbackModal && (
        <Suspense fallback={null}>
          <FeedbackModal
            isOpen={showFeedbackModal}
            onClose={() => setShowFeedbackModal(false)}
          />
        </Suspense>
      )}
    </>
  );
});
