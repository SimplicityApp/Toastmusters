import { createContext, useContext, useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { DEFAULT_ROLE_RULES, getDefaultGraceAfterRed, BREAK_ROLE, DEFAULT_BREAK_SECONDS, deriveBreakRules, parseSimpleFormatText } from '@toastmaster-timer/shared';
import { calculateStatus, formatTime, getDisplaySeconds } from '@toastmaster-timer/shared';
import { saveAgenda, loadAgenda, saveReports, loadReports, saveRoleRules, saveRoleOrder, saveHiddenBuiltinRoles, clearAgenda, clearReports, loadRevealFaceWhenIdle, saveTimerSession, loadTimerSession, clearTimerSession } from '@toastmaster-timer/shared';
import { applyOverlay, removeOverlay, getBackgroundUrl, isOverlayActive, getOverlayMode, isVideoOverlayMode, setOverlayTimeLabel, OVERLAY_MODE_CARD } from '../utils/zoomSdk';
import { parseEasySpeakText } from '@toastmaster-timer/shared';
import { recordSpeechFinished } from '@toastmaster-timer/shared';
import { recordSpeech } from '@toastmaster-timer/shared';
import { getSessionToken } from '../utils/zoomIdentity';
import { resolveActiveRules, resolveActiveHiddenBuiltins, resolveActiveRoleOrder } from '@toastmaster-timer/shared';
import { useToast } from './ToastContext';
import { trackEvent } from '../utils/posthog';

// ---------------------------------------------------------------------------
// TimerTickContext — high-frequency: elapsedTime, currentStatus, isRunning
// ---------------------------------------------------------------------------
const TimerTickContext = createContext(null);

export function useTimerTick() {
  const context = useContext(TimerTickContext);
  if (!context) {
    throw new Error('useTimerTick must be used within TimerProvider');
  }
  return context;
}

// ---------------------------------------------------------------------------
// TimerContext — stable: agenda, reports, roleRules, actions, etc.
// ---------------------------------------------------------------------------
const TimerContext = createContext(null);

export function useTimer() {
  const context = useContext(TimerContext);
  if (!context) {
    throw new Error('useTimer must be used within TimerProvider');
  }
  return context;
}

/**
 * A saved speech older than this is a leftover from an earlier meeting, not a
 * speech in progress. Zoom kills the webview the moment the app is closed, so a
 * genuine interruption is measured in seconds; an hour covers any meeting-length
 * pause without letting yesterday's forgotten timer boot the app straight into
 * a red card.
 */
export const TIMER_SESSION_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Turn the saved session, if any, into the state the timer boots with.
 *
 * @param {Array} agenda - Already-loaded agenda, so a saved link to an item
 *   that has since been removed does not come back as a dangling id.
 * @param {number} now
 * @returns {{speaker: Object, activeSpeakerId: (string|null), running: boolean,
 *   elapsed: number, status: string}|null}
 */
export function restoreTimerSession(agenda, now = Date.now()) {
  const saved = loadTimerSession();
  if (!saved) return null;
  if (now - saved.savedAt > TIMER_SESSION_MAX_AGE_MS || saved.savedAt > now) return null;
  const raw = saved.running ? saved.baseElapsed + (now - saved.startedAt) / 1000 : saved.baseElapsed;
  if (!Number.isFinite(raw) || raw < 0) return null;
  // Same tenth-of-a-second grain as the tick, so the first frame after restore
  // is a plain continuation rather than a jump.
  const elapsed = Math.round(raw * 10) / 10;
  // A paused speech that never accumulated time is indistinguishable from idle.
  if (!saved.running && elapsed === 0) return null;
  const activeSpeakerId =
    saved.activeSpeakerId && agenda.some((item) => item.id === saved.activeSpeakerId) ? saved.activeSpeakerId : null;
  return {
    speaker: saved.speaker,
    activeSpeakerId,
    running: saved.running,
    elapsed,
    status: calculateStatus(elapsed, saved.speaker.rules),
  };
}

// ---------------------------------------------------------------------------
// TimerProvider — wraps both contexts
// ---------------------------------------------------------------------------
export function TimerProvider({ children }) {
  const { showToast } = useToast();

  // --- lazy localStorage initializers (1f) ---
  const [agenda, setAgenda] = useState(() => {
    const saved = loadAgenda();
    return saved && saved.length > 0 ? saved : [];
  });

  // The speech this webview was torn down in the middle of, if any. Read once:
  // Zoom kills the webview when the app is closed, and this is how the clock
  // survives that. Held in state rather than a ref so StrictMode's second
  // initializer pass sees the same answer as the first.
  const [restoredSession] = useState(() => restoreTimerSession(agenda));

  // --- tick state (high-frequency) ---
  const [isRunning, setIsRunning] = useState(restoredSession?.running ?? false);
  const [elapsedTime, setElapsedTime] = useState(restoredSession?.elapsed ?? 0);
  const [currentStatus, setCurrentStatus] = useState(restoredSession?.status ?? 'blue');

  // --- stable state ---
  // Seeded directly rather than through setCurrentSpeaker, which resets the
  // timer as a side effect — the one thing a restore must not do.
  const [currentSpeaker, setCurrentSpeaker] = useState(restoredSession?.speaker ?? null);
  const [activeSpeakerId, setActiveSpeakerId] = useState(restoredSession?.activeSpeakerId ?? null);

  const [reports, setReports] = useState(() => {
    const saved = loadReports();
    return saved && saved.length > 0 ? saved : [];
  });

  // The three seeds below come from the club's published list when this device
  // is running it, and from the device's own keys otherwise. That decision
  // lives entirely in clubPresets.js; everything downstream — roleOptions, the
  // rules editor, the speaker picker — is unchanged either way.
  const [hiddenBuiltinRoles, setHiddenBuiltinRoles] = useState(() => resolveActiveHiddenBuiltins());

  const [roleRules, setRoleRules] = useState(() => {
    const merged = resolveActiveRules();
    // An interim build briefly shipped the break role under the name 'Break';
    // drop any saved copy so it does not linger as a stray custom role.
    delete merged['Break'];
    // After the saved rules on purpose: Break's thresholds are derived from
    // the length picked on the Live tab, never edited number by number, so a
    // stale copy that leaked into saved rules must not shadow the derivation.
    merged[BREAK_ROLE] = deriveBreakRules(DEFAULT_BREAK_SECONDS);
    return merged;
  });

  const [customRoleOrder, setCustomRoleOrder] = useState(() => resolveActiveRoleOrder());

  // --- refs ---
  const rafRef = useRef(null);
  const previousStatusRef = useRef(restoredSession?.status ?? 'blue');
  const startTimestampRef = useRef(0);
  const baseElapsedRef = useRef(restoredSession?.elapsed ?? 0);
  const liveElapsedRef = useRef(restoredSession?.elapsed ?? 0);
  // Whether a session is written down right now, so the idle path skips a
  // removal that has nothing to remove — resetTimer runs on every speaker and
  // role change, which is far too often to touch storage for no reason.
  const sessionPersistedRef = useRef(Boolean(restoredSession));
  // Keep a ref to currentSpeaker so the rAF callback always sees the latest value
  const currentSpeakerRef = useRef(currentSpeaker);
  useEffect(() => { currentSpeakerRef.current = currentSpeaker; }, [currentSpeaker]);

  // --- memoized roleOptions (1e) ---
  const roleOptions = useMemo(() => {
    const BUILT_IN_ORDER = Object.keys(DEFAULT_ROLE_RULES);
    const visibleBuiltins = BUILT_IN_ORDER.filter((r) => !hiddenBuiltinRoles.includes(r));
    const customOrder = customRoleOrder.filter((r) => roleRules[r]);
    const otherCustom = Object.keys(roleRules).filter(
      (r) => !(r in DEFAULT_ROLE_RULES) && !customOrder.includes(r)
    );
    return [...visibleBuiltins, ...customOrder, ...otherCustom];
  }, [hiddenBuiltinRoles, customRoleOrder, roleRules]);

  // The custom roles the dropdown offers, in Edit Rules order. Simple Format
  // import matches against this list, so any role you can pick you can import.
  const customRoleNames = useMemo(
    () => roleOptions.filter((r) => !(r in DEFAULT_ROLE_RULES) && r !== BREAK_ROLE),
    [roleOptions]
  );

  // --- save effects ---
  useEffect(() => { if (agenda.length > 0) saveAgenda(agenda); }, [agenda]);
  useEffect(() => { if (reports.length > 0) saveReports(reports); }, [reports]);

  // --- rAF-based timer (1d) ---
  useEffect(() => {
    if (!isRunning) return;

    startTimestampRef.current = Date.now();

    let lastRoundedElapsed = Math.round(elapsedTime * 10) / 10;

    function tick() {
      const newElapsed = baseElapsedRef.current + (Date.now() - startTimestampRef.current) / 1000;
      const rounded = Math.round(newElapsed * 10) / 10;

      if (rounded !== lastRoundedElapsed) {
        lastRoundedElapsed = rounded;
        setElapsedTime(rounded);
        liveElapsedRef.current = rounded;

        const speaker = currentSpeakerRef.current;

        // Zoom-specific: once a second, repaint the readout participants see
        // on the card — counting up for a speech, down for a break. The SDK
        // ignores this in every mode that does not render a card frame, and
        // coalesces pushes a slow client cannot keep up with.
        setOverlayTimeLabel(formatTime(getDisplaySeconds(rounded, speaker?.rules)));

        // --- batch status update (1c) ---
        if (speaker && speaker.rules) {
          const newStatus = calculateStatus(rounded, speaker.rules);
          if (newStatus !== previousStatusRef.current) {
            setCurrentStatus(newStatus);
            // Zoom-specific: apply overlay on status change
            applyOverlay(getBackgroundUrl(newStatus));
            previousStatusRef.current = newStatus;
          }
        }
      }

      rafRef.current = requestAnimationFrame(tick);
    }

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRunning]);

  // --- persist the in-progress speech ---
  // After the tick effect on purpose: effects run in declaration order, so on a
  // start (or a restored boot) startTimestampRef already holds the wall-clock
  // moment the running stretch began by the time this reads it. Keyed on the
  // transitions rather than the tick: elapsed is derived from the timestamps,
  // so nothing needs writing ten times a second. A plain RESET changes none of
  // these — it is the one caller that clears storage itself.
  useEffect(() => {
    const active = isRunning || liveElapsedRef.current > 0;
    if (!active || !currentSpeaker?.rules) {
      if (sessionPersistedRef.current) {
        clearTimerSession();
        sessionPersistedRef.current = false;
      }
      return;
    }
    saveTimerSession({
      speaker: currentSpeaker,
      activeSpeakerId,
      running: isRunning,
      baseElapsed: isRunning ? baseElapsedRef.current : liveElapsedRef.current,
      startedAt: isRunning ? startTimestampRef.current : null,
      savedAt: Date.now(),
    });
    sessionPersistedRef.current = true;
  }, [isRunning, currentSpeaker, activeSpeakerId]);

  // --- pick the card back up after a restore ---
  // A fresh webview has pushed nothing, whatever the tile is still showing from
  // before it was torn down: the readout there is frozen at the moment of the
  // close, and the color may be a threshold behind. Only ever runs with a
  // restored session, so a normal boot pushes nothing here — exactly as before.
  // applyOverlay waits for the SDK handshake itself, and skips the push in the
  // stage modes, which render the color in-app.
  // Announced once: StrictMode replays mount effects in development, and the
  // ref survives that replay where the effect closure does not.
  const restoreAnnouncedRef = useRef(false);
  useEffect(() => {
    if (!restoredSession || restoreAnnouncedRef.current) return;
    restoreAnnouncedRef.current = true;
    setOverlayTimeLabel(formatTime(getDisplaySeconds(restoredSession.elapsed, restoredSession.speaker.rules)));
    applyOverlay(getBackgroundUrl(restoredSession.status));
    showToast(restoredSession.running ? 'Timer resumed from where it was' : 'Paused timer restored', 'info');
    trackEvent('timer_session_restored', {
      running: restoredSession.running,
      elapsed_time: restoredSession.elapsed,
      role: restoredSession.speaker.role,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- actions ---
  const startTimer = useCallback(() => {
    if (!currentSpeakerRef.current || !currentSpeakerRef.current.rules) {
      showToast('Please set timing rules first', 'warning');
      return;
    }
    // baseElapsedRef is already set to current elapsed (from stopTimer or initial 0)
    const initialStatus = calculateStatus(baseElapsedRef.current, currentSpeakerRef.current.rules);
    // Before the push, so the first frame already carries the readout — the
    // full break length for a countdown, the elapsed time for a speech.
    setOverlayTimeLabel(formatTime(getDisplaySeconds(baseElapsedRef.current, currentSpeakerRef.current.rules)));
    applyOverlay(getBackgroundUrl(initialStatus));
    previousStatusRef.current = initialStatus;
    setIsRunning(true);
  }, [showToast]);

  const stopTimer = useCallback(() => {
    baseElapsedRef.current = liveElapsedRef.current;
    setIsRunning(false);
  }, []);

  /**
   * @param {{skipVideo?: boolean}} [options] - skipVideo leaves the pipelines
   *   completely alone because the caller is clearing them itself. Pressing RESET
   *   strips the tile outright rather than following the reveal-when-idle
   *   preference, and two removals in flight at once — one queued here, one
   *   bypassing the queue — is a confirmation dialog for a background that has
   *   already gone.
   */
  const resetTimer = useCallback((options) => {
    setIsRunning(false);
    baseElapsedRef.current = 0;
    liveElapsedRef.current = 0;
    setElapsedTime(0);
    setCurrentStatus('blue');
    previousStatusRef.current = 'blue';
    // Explicitly, because a paused speech being reset changes none of the state
    // the persistence effect watches: isRunning was already false.
    if (sessionPersistedRef.current) {
      clearTimerSession();
      sessionPersistedRef.current = false;
    }
    // Before any overlay call below: the speech is over, so nothing pushed
    // from here on may carry its readout. Clearing never re-pushes on its own.
    setOverlayTimeLabel(null);
    if (options?.skipVideo) return;
    // Stage modes are skipped entirely: removeOverlay there would stop the share
    // or dock the timer window.
    //
    // Everything here is gated on something actually being applied, because
    // resetTimer also runs on every speaker and role change. Without that, camera
    // mode would raise its removal confirmation dialog each time a speaker was
    // picked.
    const mode = getOverlayMode();
    if (!isVideoOverlayMode(mode)) return;

    if (!loadRevealFaceWhenIdle()) {
      // Opted out, so the color stays up and simply returns to blue — but only
      // if something is already showing, since pushing an overlay nothing is
      // displaying costs a multi-MB bridge transfer for no visible effect.
      if (isOverlayActive()) applyOverlay(getBackgroundUrl('blue'));
      return;
    }

    // A finished speech hands the organizer their video back — whichever pipeline
    // is holding the card, since to the organizer there is no difference between
    // the two. Gated on something of ours actually being up:
    // resetTimer also runs on every speaker and role change, and a removal aimed
    // at an empty pipeline costs a confirmation dialog in camera mode and reaches
    // into the user's own Video Filters setting in card mode.
    if (isOverlayActive()) {
      removeOverlay();
    }
  }, []);

  // Lightweight name-only update (no timer reset, no overlay call)
  const updateSpeakerName = useCallback((name) => {
    setCurrentSpeaker(prev => prev ? { ...prev, name } : null);
  }, []);

  /**
   * Detach the timer from the agenda without touching the agenda itself.
   *
   * For sessions that interrupt the running order rather than advance it — an
   * ad-hoc break called while a speaker was loaded. Without this, finishing
   * the break would mark that speaker's agenda item completed and advance past
   * them, consuming a slot nobody spoke in.
   */
  const clearActiveSpeaker = useCallback(() => {
    setActiveSpeakerId(null);
  }, []);

  const setCurrentSpeakerAction = useCallback((speaker) => {
    if (!speaker) {
      setCurrentSpeaker(null);
      resetTimer();
      return;
    }
    const rules = speaker.rules || roleRules[speaker.role] || DEFAULT_ROLE_RULES['Standard Speech'];
    setCurrentSpeaker({ ...speaker, rules });
    resetTimer();
  }, [roleRules, resetTimer]);

  /**
   * @param {Object} speaker
   * @param {{activate?: boolean}} [options] - activate makes the new item the
   *   speaker the timer is on. It belongs here rather than in a follow-up
   *   loadSpeakerFromAgenda call: that reads the agenda from the render it was
   *   created in, which cannot contain an item added moments earlier in the same
   *   tick, so it silently did nothing. The speaker was then on the agenda but
   *   not active — finishing could not advance to the next one, and editing the
   *   name added a second copy instead of correcting the first.
   */
  const addToAgenda = useCallback((speaker, { activate = false } = {}) => {
    const id = Date.now().toString();
    const rules = speaker.rules || roleRules[speaker.role] || DEFAULT_ROLE_RULES['Standard Speech'];
    setAgenda(prev => [...prev, { id, name: speaker.name, role: speaker.role, rules, completed: false }]);
    if (activate) {
      setCurrentSpeakerAction({ name: speaker.name, role: speaker.role, rules });
      setActiveSpeakerId(id);
    }
    trackEvent('speaker_added', { speaker_name: speaker.name || 'Unnamed', role: speaker.role });
    return id;
  }, [roleRules, setCurrentSpeakerAction]);

  const removeFromAgenda = useCallback((id) => {
    const itemToRemove = agenda.find(item => item.id === id);
    setAgenda(prev => prev.filter(item => item.id !== id));
    if (activeSpeakerId === id) setActiveSpeakerId(null);
    if (itemToRemove) trackEvent('speaker_removed', { speaker_name: itemToRemove.name || 'Unnamed', role: itemToRemove.role });
  }, [activeSpeakerId, agenda]);

  const reorderAgenda = useCallback((newOrder) => setAgenda(newOrder), []);

  /**
   * Rename an agenda speaker in place, keeping their position and role.
   * The current speaker follows along when it is the one being renamed, so a
   * correction made while they are up does not have to be made twice.
   * @param {string} id - Agenda item id
   * @param {string} name - Corrected name
   */
  const renameAgendaSpeaker = useCallback((id, name) => {
    setAgenda(prev => prev.map(item => (item.id === id ? { ...item, name } : item)));
    setCurrentSpeaker(prev => (prev && activeSpeakerId === id ? { ...prev, name } : prev));
  }, [activeSpeakerId]);

  // Edit a speaker in place so their position in the agenda is preserved
  const updateAgendaItem = useCallback((id, speaker) => {
    const rules = speaker.rules || roleRules[speaker.role] || DEFAULT_ROLE_RULES['Standard Speech'];
    setAgenda(prev => prev.map(item => (item.id === id ? { ...item, name: speaker.name, role: speaker.role, rules } : item)));
    setCurrentSpeaker(prev => (prev && activeSpeakerId === id ? { ...prev, name: speaker.name, role: speaker.role, rules } : prev));
  }, [roleRules, activeSpeakerId]);

  const clearAllAgenda = useCallback(() => {
    const agendaCount = agenda.length;
    setAgenda([]);
    setActiveSpeakerId(null);
    clearAgenda();
    trackEvent('agenda_cleared', { items_count: agendaCount });
  }, [agenda]);

  const markCompleted = useCallback((id) => {
    setAgenda(prev => prev.map(item =>
      item.id === id ? { ...item, completed: true } : item
    ));
  }, []);

  const loadSpeakerFromAgenda = useCallback((id) => {
    const speaker = agenda.find(item => item.id === id);
    if (speaker) {
      const speakerData = { name: speaker.name, role: speaker.role };
      if (speaker.rules) speakerData.rules = speaker.rules;
      setCurrentSpeakerAction(speakerData);
      setActiveSpeakerId(id);
    }
  }, [agenda, setCurrentSpeakerAction]);

  const importBulkSpeakers = useCallback((text) => {
    const newItems = parseSimpleFormatText(text, customRoleNames).map(({ name, role }, index) => ({
      id: `${Date.now()}-${index}`,
      name,
      role,
      rules: roleRules[role] || DEFAULT_ROLE_RULES['Standard Speech'],
      completed: false,
    }));
    setAgenda(prev => [...prev, ...newItems]);
    trackEvent('agenda_imported', {
      import_type: 'bulk',
      items_count: newItems.length,
      custom_role_count: newItems.filter((item) => customRoleNames.includes(item.role)).length,
    });
    return newItems.length;
  }, [roleRules, customRoleNames]);

  const importEasySpeakSpeakers = useCallback((text) => {
    const parsedItems = parseEasySpeakText(text);
    const newItems = parsedItems.map((item, index) => {
      const role = item.role;
      const rules = roleRules[role] || DEFAULT_ROLE_RULES['Standard Speech'];
      return { id: `${Date.now()}-${index}`, name: item.name, role, originalShortRole: item.originalShortRole || null, rules, completed: false };
    });
    setAgenda(prev => [...prev, ...newItems]);
    trackEvent('agenda_imported', { import_type: 'easyspeak', items_count: newItems.length });
    return newItems.length;
  }, [roleRules]);

  const formatPassedRedComment = useCallback((elapsedSeconds, redThreshold) => {
    if (elapsedSeconds <= redThreshold) return '';
    const overTime = elapsedSeconds - redThreshold;
    const minutes = Math.floor(overTime / 60);
    const seconds = Math.floor(overTime % 60);
    if (minutes > 0) {
      if (seconds > 0) return `Passed red by ${minutes} minute${minutes > 1 ? 's' : ''} ${seconds} second${seconds > 1 ? 's' : ''}`;
      return `Passed red by ${minutes} minute${minutes > 1 ? 's' : ''}`;
    }
    return `Passed red by ${seconds} second${seconds > 1 ? 's' : ''}`;
  }, []);

  const formatBeforeGreenComment = useCallback((elapsedSeconds, greenThreshold) => {
    if (elapsedSeconds >= greenThreshold) return '';
    const underTime = greenThreshold - elapsedSeconds;
    const minutes = Math.floor(underTime / 60);
    const seconds = Math.floor(underTime % 60);
    if (minutes > 0) {
      if (seconds > 0) return `Finished ${minutes} minute${minutes > 1 ? 's' : ''} ${seconds} second${seconds > 1 ? 's' : ''} before green`;
      return `Finished ${minutes} minute${minutes > 1 ? 's' : ''} before green`;
    }
    return `Finished ${seconds} second${seconds > 1 ? 's' : ''} before green`;
  }, []);

  // The record grows an id and a finish time. Both are for the club archive:
  // the id is what makes the upload an append to a key that has never existed,
  // so a retry rewrites the same bytes, and the timestamp is what orders a
  // meeting two laptops timed together. They stay out of SYNCED_KEYS all the
  // same — see the note on `toastmaster_reports` in profileMerge.js.
  const addReport = useCallback((entry) => {
    const record = {
      speechId: (globalThis.crypto?.randomUUID?.() ?? `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`),
      name: entry.name,
      role: entry.role,
      duration: formatTime(entry.duration),
      color: entry.color,
      comments: entry.comments || '',
      disqualified: entry.disqualified === true,
      finishedAt: Date.now(),
    };
    setReports(prev => [...prev, record]);
    return record;
  }, []);

  const clearAllReports = useCallback(() => {
    setReports([]);
    clearReports();
  }, []);

  const finishCurrentSpeech = useCallback(() => {
    if (currentSpeaker && elapsedTime > 0) {
      const rules = currentSpeaker.rules;
      const grace = rules ? (rules.graceAfterRed ?? getDefaultGraceAfterRed(currentSpeaker.role)) : 30;
      // A break has no disqualification and no under/over commentary: nobody
      // "runs over" a break, the meeting just resumes.
      const disqualified = rules && !rules.countdown ? elapsedTime > rules.red + grace : false;
      let comment = '';
      if (rules && !rules.countdown) {
        if (elapsedTime > rules.red) {
          comment = formatPassedRedComment(elapsedTime, rules.red);
          if (disqualified) comment += ' (Disqualified)';
        } else if (elapsedTime < rules.green) {
          comment = formatBeforeGreenComment(elapsedTime, rules.green);
        }
      }
      const record = addReport({ name: currentSpeaker.name, role: currentSpeaker.role, duration: elapsedTime, color: currentStatus, comments: comment, disqualified });
      // Queued, not awaited: FINISH hands the timer back to the organizer at
      // once, and a club that cannot be reached right now is a retry rather
      // than anything anybody has to see. A device with no club queues nothing.
      recordSpeech(record, { getToken: getSessionToken });
      trackEvent('speech_finished', { speaker_name: currentSpeaker.name || 'Unnamed', role: currentSpeaker.role, duration: elapsedTime, final_status: currentStatus });
      // Drives the periodic prompt cadence (see PeriodicPrompts).
      recordSpeechFinished();
      if (activeSpeakerId) markCompleted(activeSpeakerId);
      resetTimer();
      setActiveSpeakerId(null);
    }
  }, [currentSpeaker, elapsedTime, currentStatus, activeSpeakerId, addReport, markCompleted, resetTimer, formatPassedRedComment, formatBeforeGreenComment]);

  const updateRoleRules = useCallback((role, rules) => {
    setRoleRules(prev => {
      const updated = { ...prev, [role]: rules };
      saveRoleRules(updated);
      return updated;
    });
  }, []);

  const addRoleRules = useCallback((role, rules) => {
    setRoleRules(prev => {
      const updated = { ...prev, [role]: rules };
      saveRoleRules(updated);
      return updated;
    });
    setCustomRoleOrder(prev => {
      if (prev.includes(role)) return prev;
      const next = [...prev, role];
      saveRoleOrder(next);
      return next;
    });
  }, []);

  const removeRoleRules = useCallback((role) => {
    if (role in DEFAULT_ROLE_RULES) {
      setHiddenBuiltinRoles(prev => {
        if (prev.includes(role)) return prev;
        saveHiddenBuiltinRoles([...prev, role]);
        return [...prev, role];
      });
      setRoleRules(prev => {
        const { [role]: _, ...rest } = prev;
        saveRoleRules(rest);
        return rest;
      });
      return;
    }
    setRoleRules(prev => {
      const { [role]: _, ...rest } = prev;
      saveRoleRules(rest);
      return rest;
    });
    setCustomRoleOrder(prev => {
      const next = prev.filter((r) => r !== role);
      saveRoleOrder(next);
      return next;
    });
  }, []);

  const resetAllRoleRulesToDefaults = useCallback(() => {
    setHiddenBuiltinRoles([]);
    saveHiddenBuiltinRoles([]);
    setRoleRules(prev => {
      const customOnly = Object.fromEntries(Object.entries(prev).filter(([r]) => !(r in DEFAULT_ROLE_RULES)));
      const updated = { ...DEFAULT_ROLE_RULES, ...customOnly };
      saveRoleRules(updated);
      return updated;
    });
  }, []);

  /**
   * Re-read whichever timing list is now live.
   *
   * The seeds above run once, at mount. Moving the club/personal switch, or
   * taking a freshly published list, changes the answer they were seeded from,
   * so the editor calls this instead of asking the timer to be reloaded.
   */
  const reloadRoleRules = useCallback(() => {
    setHiddenBuiltinRoles(resolveActiveHiddenBuiltins());
    setCustomRoleOrder(resolveActiveRoleOrder());
    setRoleRules(() => {
      const merged = resolveActiveRules();
      delete merged['Break'];
      merged[BREAK_ROLE] = deriveBreakRules(DEFAULT_BREAK_SECONDS);
      return merged;
    });
  }, []);

  // --- memoized context values (1b) ---
  const tickValue = useMemo(() => ({
    elapsedTime,
    currentStatus,
    isRunning,
  }), [elapsedTime, currentStatus, isRunning]);

  const stableValue = useMemo(() => ({
    currentSpeaker,
    agenda,
    activeSpeakerId,
    reports,
    roleRules,
    roleOptions,
    startTimer,
    stopTimer,
    resetTimer,
    setCurrentSpeaker: setCurrentSpeakerAction,
    updateSpeakerName,
    clearActiveSpeaker,
    addToAgenda,
    removeFromAgenda,
    reorderAgenda,
    renameAgendaSpeaker,
    updateAgendaItem,
    markCompleted,
    loadSpeakerFromAgenda,
    importBulkSpeakers,
    importEasySpeakSpeakers,
    clearAllAgenda,
    addReport,
    finishCurrentSpeech,
    clearAllReports,
    updateRoleRules,
    addRoleRules,
    removeRoleRules,
    resetAllRoleRulesToDefaults,
    reloadRoleRules,
  }), [
    currentSpeaker,
    agenda,
    activeSpeakerId,
    reports,
    roleRules,
    roleOptions,
    startTimer,
    stopTimer,
    resetTimer,
    setCurrentSpeakerAction,
    updateSpeakerName,
    clearActiveSpeaker,
    addToAgenda,
    removeFromAgenda,
    reorderAgenda,
    renameAgendaSpeaker,
    updateAgendaItem,
    markCompleted,
    loadSpeakerFromAgenda,
    importBulkSpeakers,
    importEasySpeakSpeakers,
    clearAllAgenda,
    addReport,
    finishCurrentSpeech,
    clearAllReports,
    updateRoleRules,
    addRoleRules,
    removeRoleRules,
    resetAllRoleRulesToDefaults,
    reloadRoleRules,
  ]);

  return (
    <TimerTickContext.Provider value={tickValue}>
      <TimerContext.Provider value={stableValue}>
        {children}
      </TimerContext.Provider>
    </TimerTickContext.Provider>
  );
}
