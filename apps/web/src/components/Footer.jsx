import { useState, lazy, Suspense, memo } from 'react';
import { ExternalLink, MessageSquare, Star } from 'lucide-react';
import {
  FEEDBACK_SURVEY_ID,
  REVIEW_PROMPT,
  REVIEW_SURVEY_ID,
  ZOOM_MARKETPLACE_LISTING_URL,
  ZOOM_MARKETPLACE_REVIEW_URL,
  markPromptAnswered,
} from '@toastmaster-timer/shared';
import { trackEvent } from '../utils/posthog';
const FeedbackModal = lazy(() => import('./FeedbackModal'));

export default memo(function Footer() {
  // A build without the install link sends people to the Marketplace listing.
  const ADD_TO_ZOOM_URL = import.meta.env.VITE_ZOOM_OAUTH_REDIRECT || ZOOM_MARKETPLACE_LISTING_URL;
  const [showFeedbackModal, setShowFeedbackModal] = useState(false);

  const handleFeedbackClick = () => {
    trackEvent('survey_opened', { $survey_id: FEEDBACK_SURVEY_ID });
    setShowFeedbackModal(true);
  };

  // Someone who reviews of their own accord should never see the periodic ask.
  const handleReviewClick = () => {
    trackEvent('review_prompt_accepted', {
      destination: 'zoom_marketplace',
      source: 'footer',
    });
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
      <footer className="w-full border-t border-gray-200 bg-white px-4 py-2 flex items-center justify-center gap-2">
        <a
          href={ADD_TO_ZOOM_URL}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => trackEvent('cta_clicked', { cta: 'add_to_zoom', location: 'timer-footer', page: '/timer/app' })}
          className="flex items-center gap-2 px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-50 rounded-md transition-colors"
        >
          <ExternalLink className="w-4 h-4" />
          Add to Zoom
        </a>
        <button
          onClick={handleFeedbackClick}
          className="flex items-center gap-2 px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-50 rounded-md transition-colors"
        >
          <MessageSquare className="w-4 h-4" />
          Send Us Feedback
        </button>
        <a
          href={ZOOM_MARKETPLACE_REVIEW_URL}
          target="_blank"
          rel="noopener noreferrer"
          onClick={handleReviewClick}
          className="flex items-center gap-2 px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-50 rounded-md transition-colors"
        >
          <Star className="w-4 h-4" />
          Leave a Review
        </a>
      </footer>
      {showFeedbackModal && (
        <Suspense fallback={null}>
          <FeedbackModal isOpen={showFeedbackModal} onClose={() => setShowFeedbackModal(false)} />
        </Suspense>
      )}
    </>
  );
});
