import { createContext, useContext, useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { DEFAULT_ROLE_RULES, detectRoleFromText, getDefaultGraceAfterRed } from '@toastmaster-timer/shared';
import { calculateStatus, formatTime } from '@toastmaster-timer/shared';
import { saveAgenda, loadAgenda, saveReports, loadReports, saveRoleRules, saveRoleOrder, saveHiddenBuiltinRoles, clearAgenda, clearReports } from '@toastmaster-timer/shared';
import { parseEasySpeakText } from '@toastmaster-timer/shared';
import { recordSpeechFinished } from '@toastmaster-timer/shared';
import { resolveActiveRules, resolveActiveHiddenBuiltins, resolveActiveRoleOrder } from '@toastmaster-timer/shared';
import { setPageBackgroundFromStatus } from '../utils/pageBackground';
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

// ---------------------------------------------------------------------------
// TimerProvider — wraps both contexts
// ---------------------------------------------------------------------------
export function TimerProvider({ children }) {
  const { showToast } = useToast();

  // --- tick state (high-frequency) ---
  const [isRunning, setIsRunning] = useState(false);
  const [elapsedTime, setElapsedTime] = useState(0);
  const [currentStatus, setCurrentStatus] = useState('blue');

  // --- stable state ---
  const [currentSpeaker, setCurrentSpeaker] = useState(null);
  const [activeSpeakerId, setActiveSpeakerId] = useState(null);

  // --- lazy localStorage initializers (1f) ---
  const [agenda, setAgenda] = useState(() => {
    const saved = loadAgenda();
    return saved && saved.length > 0 ? saved : [];
  });

  const [reports, setReports] = useState(() => {
    const saved = loadReports();
    return saved && saved.length > 0 ? saved : [];
  });

  // Seeded from the club's published list when this device is running it, and
  // from the device's own keys otherwise. The decision lives in clubPresets.js.
  const [hiddenBuiltinRoles, setHiddenBuiltinRoles] = useState(() => resolveActiveHiddenBuiltins());

  const [roleRules, setRoleRules] = useState(() => resolveActiveRules());

  const [customRoleOrder, setCustomRoleOrder] = useState(() => resolveActiveRoleOrder());

  // --- refs ---
  const rafRef = useRef(null);
  const previousStatusRef = useRef('blue');
  const startTimestampRef = useRef(0);
  const baseElapsedRef = useRef(0);
  const liveElapsedRef = useRef(0);
  // Keep a ref to currentSpeaker so the rAF callback always sees the latest value
  // without being re-registered on every speaker change.
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

        // --- batch status update (1c) ---
        const speaker = currentSpeakerRef.current;
        if (speaker && speaker.rules) {
          const newStatus = calculateStatus(rounded, speaker.rules);
          if (newStatus !== previousStatusRef.current) {
            setCurrentStatus(newStatus);
            setPageBackgroundFromStatus(newStatus);
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

  // --- actions ---
  const startTimer = useCallback(() => {
    if (!currentSpeakerRef.current || !currentSpeakerRef.current.rules) {
      showToast('Please set timing rules first', 'warning');
      return;
    }
    // baseElapsedRef is already set to current elapsed (from stopTimer or initial 0)
    const initialStatus = calculateStatus(baseElapsedRef.current, currentSpeakerRef.current.rules);
    setPageBackgroundFromStatus(initialStatus);
    previousStatusRef.current = initialStatus;
    setIsRunning(true);
  }, [showToast]);

  const stopTimer = useCallback(() => {
    baseElapsedRef.current = liveElapsedRef.current;
    setIsRunning(false);
  }, []);

  const resetTimer = useCallback(() => {
    setIsRunning(false);
    baseElapsedRef.current = 0;
    liveElapsedRef.current = 0;
    setElapsedTime(0);
    setCurrentStatus('blue');
    previousStatusRef.current = 'blue';
    setPageBackgroundFromStatus('blue');
  }, []);

  // Lightweight name-only update (no timer reset)
  const updateSpeakerName = useCallback((name) => {
    setCurrentSpeaker(prev => prev ? { ...prev, name } : null);
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

  const addToAgenda = useCallback((speaker) => {
    const id = Date.now().toString();
    const rules = speaker.rules || roleRules[speaker.role] || DEFAULT_ROLE_RULES['Standard Speech'];
    setAgenda(prev => [...prev, { id, name: speaker.name, role: speaker.role, rules, completed: false }]);
    trackEvent('speaker_added', { speaker_name: speaker.name || 'Unnamed', role: speaker.role });
    return id;
  }, [roleRules]);

  const removeFromAgenda = useCallback((id) => {
    const itemToRemove = agenda.find(item => item.id === id);
    setAgenda(prev => prev.filter(item => item.id !== id));
    if (activeSpeakerId === id) setActiveSpeakerId(null);
    if (itemToRemove) trackEvent('speaker_removed', { speaker_name: itemToRemove.name || 'Unnamed', role: itemToRemove.role });
  }, [activeSpeakerId, agenda]);

  const reorderAgenda = useCallback((newOrder) => setAgenda(newOrder), []);

  // Edit a speaker in place so their position in the agenda is preserved
  const updateAgendaItem = useCallback((id, speaker) => {
    const rules = speaker.rules || roleRules[speaker.role] || DEFAULT_ROLE_RULES['Standard Speech'];
    setAgenda(prev => prev.map(item => (item.id === id ? { ...item, name: speaker.name, role: speaker.role, rules } : item)));
    if (activeSpeakerId === id) {
      setCurrentSpeaker(prev => (prev ? { ...prev, name: speaker.name, role: speaker.role, rules } : prev));
    }
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
    const lines = text.split('\n').filter(line => line.trim());
    const newItems = lines.map((line, index) => {
      const trimmed = line.trim();
      const role = detectRoleFromText(trimmed, customRoleOrder);
      const name = trimmed.replace(/\(.*?\)/g, '').trim() || `Speaker ${index + 1}`;
      const rules = roleRules[role] || DEFAULT_ROLE_RULES['Standard Speech'];
      return { id: `${Date.now()}-${index}`, name, role, rules, completed: false };
    });
    setAgenda(prev => [...prev, ...newItems]);
    trackEvent('agenda_imported', { import_type: 'bulk', items_count: newItems.length });
    return newItems.length;
  }, [roleRules, customRoleOrder]);

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

  const addReport = useCallback((entry) => {
    setReports(prev => [...prev, {
      name: entry.name,
      role: entry.role,
      duration: formatTime(entry.duration),
      color: entry.color,
      comments: entry.comments || '',
      disqualified: entry.disqualified === true
    }]);
  }, []);

  const clearAllReports = useCallback(() => {
    setReports([]);
    clearReports();
  }, []);

  const finishCurrentSpeech = useCallback(() => {
    if (currentSpeaker && elapsedTime > 0) {
      const rules = currentSpeaker.rules;
      const grace = rules ? (rules.graceAfterRed ?? getDefaultGraceAfterRed(currentSpeaker.role)) : 30;
      const disqualified = rules ? elapsedTime > rules.red + grace : false;
      let comment = '';
      if (rules) {
        if (elapsedTime > rules.red) {
          comment = formatPassedRedComment(elapsedTime, rules.red);
          if (disqualified) comment += ' (Disqualified)';
        } else if (elapsedTime < rules.green) {
          comment = formatBeforeGreenComment(elapsedTime, rules.green);
        }
      }
      addReport({ name: currentSpeaker.name, role: currentSpeaker.role, duration: elapsedTime, color: currentStatus, comments: comment, disqualified });
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
   * taking a freshly published list, changes the answer they were seeded from.
   */
  const reloadRoleRules = useCallback(() => {
    setHiddenBuiltinRoles(resolveActiveHiddenBuiltins());
    setCustomRoleOrder(resolveActiveRoleOrder());
    setRoleRules(resolveActiveRules());
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
    addToAgenda,
    removeFromAgenda,
    reorderAgenda,
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
    addToAgenda,
    removeFromAgenda,
    reorderAgenda,
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
