import { useEffect, useRef, useState } from 'react';
import { useTimerTick } from '../context/TimerContext';
import { useFlag } from '../hooks/useFlag';
import { resolveZoomIdentity } from '../utils/zoomIdentity';
import { attempt, eligible, readCaptureState } from '../utils/contactCapture';

// The same polite-moment rule as PeriodicPrompts: never while a speech is
// being timed, and only after a short grace once the timer is idle, so Zoom's
// consent screen cannot land on top of someone lining up the next speaker.
export const SHOW_DELAY_MS = 2500;

/**
 * Asks Zoom, once per load, for the approval that lets the Worker save this
 * user's Zoom email and name (utils/contactCapture.js).
 *
 * Renders nothing. It waits for an identified, eligible user and an idle
 * timer, then runs the automatic attempt. A user who skips Zoom's screen is
 * moved to card mode by that attempt and is not asked automatically again.
 */
export default function ContactCapture() {
  const { isRunning } = useTimerTick();
  const { enabled: flagOn } = useFlag('contact_capture');
  const [session, setSession] = useState(null);
  const attempted = useRef(false);

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

  useEffect(() => {
    if (attempted.current || isRunning || !session) return undefined;
    const due = () => eligible(session, flagOn, Date.now()) && readCaptureState(session.uid).mode === 'auto';
    if (!due()) return undefined;

    const timer = setTimeout(() => {
      // Re-checked at fire time: another tab or window may have asked since.
      if (attempted.current || !due()) return;
      attempted.current = true;
      attempt('auto', session);
    }, SHOW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [session, flagOn, isRunning]);

  return null;
}
