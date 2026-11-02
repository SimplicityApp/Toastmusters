import { useEffect, useRef, useState } from 'react';
import { useTimerTick } from '../context/TimerContext';
import { useFlag } from '../hooks/useFlag';
import { resolveZoomIdentity } from '../utils/zoomIdentity';
import { attempt, eligible, readCaptureState, snooze } from '../utils/contactCapture';
import ContactCaptureCard from './ContactCaptureCard';

// The same polite-moment rule as PeriodicPrompts: never while a speech is
// being timed, and only after a short grace once the timer is idle, so Zoom's
// consent screen (or the card) cannot land on top of someone lining up the
// next speaker.
export const SHOW_DELAY_MS = 2500;

/** Eligible right now, and in the given mode of the stored state. */
function isDue(session, flagOn, mode) {
  return Boolean(session) && eligible(session, flagOn, Date.now()) && readCaptureState(session.uid).mode === mode;
}

/**
 * Asks Zoom for the approval that lets the Worker save this user's Zoom email
 * and name (utils/contactCapture.js).
 *
 * It waits for an identified, eligible user and an idle timer. In auto mode it
 * runs the automatic attempt, once per load. A user who skipped Zoom's screen
 * is in card mode instead, and gets the "Stay in touch" card at the next idle
 * moment; the card comes down as soon as a speech starts and comes back after
 * the next grace, until it is answered.
 */
export default function ContactCapture() {
  const { isRunning } = useTimerTick();
  const { enabled: flagOn } = useFlag('contact_capture');
  const [session, setSession] = useState(null);
  // Bumped whenever an ask rewrites the stored state, so the effects below
  // read it again (a skipped automatic ask is what brings the card).
  const [revision, setRevision] = useState(0);
  const [cardShown, setCardShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const attempted = useRef(false);
  // Saved, or the card has had its answer: nothing more to ask on this load.
  const settled = useRef(false);

  const settle = () => {
    settled.current = true;
    setCardShown(false);
    setRevision((n) => n + 1);
  };

  useEffect(() => {
    let live = true;
    // Single-flight and never rejects: this shares the one identity round trip.
    resolveZoomIdentity().then((identity) => {
      if (live) setSession(identity);
    });
    return () => {
      live = false;
    };
  }, []);

  // Auto mode: the one automatic ask.
  useEffect(() => {
    if (attempted.current || settled.current || isRunning || !isDue(session, flagOn, 'auto')) return undefined;

    const timer = setTimeout(() => {
      // Re-checked at fire time: another tab or window may have asked since.
      if (attempted.current || settled.current || !isDue(session, flagOn, 'auto')) return;
      attempted.current = true;
      // A code that arrives after the timeout is still saved; the card, which
      // the skip may have brought up meanwhile, then comes down.
      attempt('auto', session, { onLateSaved: settle }).then((result) => {
        if (result === 'saved') settled.current = true;
        setRevision((n) => n + 1);
      });
    }, SHOW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [session, flagOn, isRunning]);

  // Card mode: show the card once the timer has been idle for the grace.
  useEffect(() => {
    if (isRunning) {
      // Down the moment a speech starts; the grace starts over after it.
      setCardShown(false);
      return undefined;
    }
    if (cardShown || busy || settled.current || !isDue(session, flagOn, 'card')) return undefined;

    const timer = setTimeout(() => {
      if (settled.current || !isDue(session, flagOn, 'card')) return;
      setCardShown(true);
    }, SHOW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [session, flagOn, isRunning, revision, cardShown, busy]);

  const approve = async () => {
    if (busy) return;
    setBusy(true);
    // Skipped again or failed: attempt() has already pushed the card a week
    // out. Saved: the state is cleared. Either way the card is done for now.
    await attempt('card', session, { onLateSaved: settle });
    setBusy(false);
    settle();
  };

  const dismiss = () => {
    snooze(session.uid, Date.now());
    settle();
  };

  if (!cardShown || isRunning) return null;

  return <ContactCaptureCard onApprove={approve} onDismiss={dismiss} busy={busy} />;
}
