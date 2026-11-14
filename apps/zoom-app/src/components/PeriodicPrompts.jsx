import { useEffect, useRef, useState, lazy, Suspense } from 'react';
import {
  CLUB_PROMPT,
  PRO_LAUNCH_PROMPT,
  REVIEW_PROMPT,
  loadPromptState,
  markPromptAnswered,
  markPromptDeclined,
  markPromptShown,
  selectDuePrompt,
  subscribeToForcedPrompt,
  subscribeToPromptState,
} from '@toastmaster-timer/shared';
import { useTimerTick } from '../context/TimerContext';
import { useEntitlement } from '../hooks/useEntitlement';
import { useFlag } from '../hooks/useFlag';
import { trackEvent } from '../utils/posthog';

const ClubSurveyModal = lazy(() => import('./ClubSurveyModal'));
const ReviewPromptModal = lazy(() => import('./ReviewPromptModal'));
const ProLaunchModal = lazy(() => import('./ProLaunchModal'));

// Prompts this app always asks. The review ask belongs here, where the user
// installed the Zoom app in the first place.
const BASE_PROMPTS = [CLUB_PROMPT, REVIEW_PROMPT];
// Plus the Pro announcement, once Pro is released and only to devices that are
// not Pro already: nobody is told about something they have.
const WITH_PRO_LAUNCH = [PRO_LAUNCH_PROMPT, ...BASE_PROMPTS];

// Breathing room after "Finish" before a modal appears: the user has just
// stopped a speech and may be lining up the next speaker. If they start the
// next one within the delay the prompt stays queued and waits for the next gap.
const SHOW_DELAY_MS = 2500;

/**
 * Shows an occasional prompt (club question, Zoom review, the one-time Pro
 * announcement) once the user has timed enough speeches. Cadence and history
 * live in the shared prompt scheduler; this component only decides which
 * prompts apply and when it is polite to interrupt.
 */
export default function PeriodicPrompts() {
  const { isRunning } = useTimerTick();
  const { isPro, known: planKnown } = useEntitlement();
  const { enabled: proReleased, known: flagsKnown } = useFlag('pro');
  // Queued: due, but waiting for a safe moment. Visible: actually on screen.
  const [queued, setQueued] = useState(null);
  const [visible, setVisible] = useState(null);

  // Both answers must be in: a Pro device whose plan has not loaded yet looks
  // free for a moment, and must not be told about Pro in that moment.
  const proLaunchEligible = flagsKnown && proReleased && planKnown && !isPro;
  // A ref, so the store subscription and the delayed re-check below read the
  // current gate rather than the one they were created with.
  const enabledRef = useRef(BASE_PROMPTS);
  enabledRef.current = proLaunchEligible ? WITH_PRO_LAUNCH : BASE_PROMPTS;

  useEffect(
    () =>
      subscribeToPromptState((state) => {
        setQueued((current) => current ?? selectDuePrompt(state, Date.now(), enabledRef.current));
      }),
    []
  );

  // Debug panel only: straight to the screen, no cadence and no delay.
  useEffect(
    () =>
      subscribeToForcedPrompt((prompt) => {
        setQueued(null);
        setVisible(prompt);
      }),
    []
  );

  useEffect(() => {
    if (!queued || visible || isRunning) return;

    const timer = setTimeout(() => {
      // Re-check against stored state: another tab or window may have asked
      // since this prompt was queued.
      const due = selectDuePrompt(loadPromptState(), Date.now(), enabledRef.current);
      if (!due) {
        setQueued(null);
        return;
      }
      markPromptShown(due);
      trackEvent('periodic_prompt_shown', { prompt: due });
      setVisible(due);
    }, SHOW_DELAY_MS);

    return () => clearTimeout(timer);
  }, [queued, visible, isRunning]);

  const close = () => {
    setVisible(null);
    setQueued(null);
  };

  // Answered and declined are both terminal in the scheduler; a plain dismissal
  // just counts as one ask and leaves the prompt eligible later.
  const handleAnswered = (prompt) => {
    markPromptAnswered(prompt);
    trackEvent('periodic_prompt_answered', { prompt });
    close();
  };

  const handleDismiss = (prompt) => {
    trackEvent('periodic_prompt_dismissed', { prompt });
    close();
  };

  const handleDecline = (prompt) => {
    markPromptDeclined(prompt);
    trackEvent('periodic_prompt_declined', { prompt });
    close();
  };

  if (!visible) return null;

  return (
    <Suspense fallback={null}>
      {visible === CLUB_PROMPT && (
        <ClubSurveyModal
          isOpen
          onAnswered={() => handleAnswered(CLUB_PROMPT)}
          onDismiss={() => handleDismiss(CLUB_PROMPT)}
          onDecline={() => handleDecline(CLUB_PROMPT)}
        />
      )}
      {visible === REVIEW_PROMPT && (
        <ReviewPromptModal
          isOpen
          onAnswered={() => handleAnswered(REVIEW_PROMPT)}
          onDismiss={() => handleDismiss(REVIEW_PROMPT)}
          onDecline={() => handleDecline(REVIEW_PROMPT)}
        />
      )}
      {visible === PRO_LAUNCH_PROMPT && (
        <ProLaunchModal
          isOpen
          onAnswered={() => handleAnswered(PRO_LAUNCH_PROMPT)}
          onDismiss={() => handleDismiss(PRO_LAUNCH_PROMPT)}
        />
      )}
    </Suspense>
  );
}
