import { useState } from 'react';
import { X, Send } from 'lucide-react';
import { CLUB_SURVEY_ID } from '@toastmaster-timer/shared';
import { trackEvent } from '../utils/posthog';
import { submitClubResponse } from '../utils/clubSurvey';
import { useLook } from '../b/LookContext';
import Sheet from '../b/Sheet';

/**
 * Periodic prompt asking which Toastmasters club the user belongs to.
 * Shown by PeriodicPrompts, never on its own.
 */
export default function ClubSurveyModal({ isOpen, onAnswered, onDismiss, onDecline }) {
  const [club, setClub] = useState('');
  const [district, setDistrict] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const look = useLook();

  const handleSubmit = () => {
    if (submitted) return;
    if (!submitClubResponse({ club, district, source: 'periodic_prompt' })) return;

    setSubmitted(true);
    setTimeout(onAnswered, 1500);
  };

  const handleDismiss = () => {
    if (CLUB_SURVEY_ID) {
      trackEvent('survey dismissed', { $survey_id: CLUB_SURVEY_ID });
    }
    onDismiss();
  };

  const body = (
    <>
      {submitted ? (
        <p className="text-green-600 font-medium py-4 text-center">
          Thank you — that helps a lot!
        </p>
      ) : (
        <>
          <p className="text-sm text-gray-600 mb-4">
            Knowing which clubs use the timer helps us build the right features. One question,
            then we won&apos;t ask again.
          </p>

          <div className="mb-3">
            <label htmlFor="club-name" className="block text-sm font-medium text-gray-700 mb-1">
              Club name
            </label>
            <input
              id="club-name"
              type="text"
              value={club}
              onChange={(e) => setClub(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
              placeholder="e.g. Downtown Speakers"
              autoFocus
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
            />
          </div>

          <div className="mb-4">
            <label htmlFor="club-district" className="block text-sm font-medium text-gray-700 mb-1">
              District <span className="text-gray-400 font-normal">(optional)</span>
            </label>
            <input
              id="club-district"
              type="text"
              value={district}
              onChange={(e) => setDistrict(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
              placeholder="e.g. 61"
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
            />
          </div>

          <div className="flex gap-2 justify-end">
            <button
              onClick={handleDismiss}
              className="px-4 py-2 bg-gray-300 hover:bg-gray-400 text-gray-800 font-semibold rounded-lg transition-colors text-sm"
            >
              Not now
            </button>
            <button
              onClick={handleSubmit}
              disabled={!club.trim()}
              className="flex items-center gap-2 px-4 py-2 bg-blue-500 hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-lg transition-colors text-sm"
            >
              <Send className="w-4 h-4" />
              Submit
            </button>
          </div>

          <button
            onClick={onDecline}
            className="mt-3 w-full text-center text-xs text-gray-400 hover:text-gray-600 transition-colors"
          >
            Don&apos;t ask me again
          </button>
        </>
      )}
    </>
  );

  if (!isOpen) return null;

  // Design B (plan 13): the same question as a sheet from the bottom edge.
  if (look === 'b') {
    return (
      <Sheet open onClose={handleDismiss} title="Which club are you from?">
        {body}
      </Sheet>
    );
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg p-6 w-full max-w-md">
        <div className="flex justify-between items-start mb-4">
          <h3 className="text-lg font-semibold">Which club are you from?</h3>
          <button
            onClick={handleDismiss}
            className="text-gray-400 hover:text-gray-600 flex-shrink-0"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {body}
      </div>
    </div>
  );
}
