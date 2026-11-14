import { useState, useEffect, useRef, useMemo, memo, lazy, Suspense } from 'react';
import { useTimer, useTimerTick } from '../context/TimerContext';
import { useToast } from '../context/ToastContext';
import { Play, Square, RotateCcw, Image, Volume2, Lock } from 'lucide-react';
import SpeakerInput from './SpeakerInput';
import TimerDisplay from './TimerDisplay';
const EditRulesModal = lazy(() => import('./EditRulesModal'));
const CardImagesModal = lazy(() => import('./CardImagesModal'));
const SoundsModal = lazy(() => import('./SoundsModal'));
import TimeInput, { TimeInputModeToggle } from './TimeInput';
import { DEFAULT_ROLE_RULES, DEFAULT_CUSTOM_RULES, loadTimeInputMode, saveTimeInputMode, initCardImages, subscribeCardImages, agendaItemNeedsRole } from '@toastmaster-timer/shared';
import { setPageBackgroundFromStatus } from '../utils/pageBackground';
import { parseSpeakerFromSearch, stripSpeakerParams } from '../utils/speakerDeepLink';
import { getCardImageUrl, preloadCardImages } from '../utils/cardArtwork';
import { trackEvent } from '../utils/posthog';
import { useClub } from '../hooks/useClub';
import { SOUNDS_LOCK_MESSAGES, useSoundsAccess } from '../hooks/useSounds';
import { clubBadgePlacement } from '@toastmaster-timer/shared';

const PREVIEW_COLORS = [
  { color: 'blue', hex: '#1e3a5f' },
  { color: 'green', hex: '#22c55e' },
  { color: 'yellow', hex: '#eab308' },
  { color: 'red', hex: '#dc2626' },
];

export default memo(function LiveTab({ onTimerStart }) {
  const { isRunning, elapsedTime, currentStatus } = useTimerTick();
  const {
    currentSpeaker,
    startTimer,
    stopTimer,
    resetTimer,
    setCurrentSpeaker,
    updateSpeakerName,
    clearActiveSpeaker,
    finishCurrentSpeech,
    roleRules,
    roleOptions,
    agenda,
    activeSpeakerId,
    loadSpeakerFromAgenda,
  } = useTimer();
  const { showToast } = useToast();
  // The club's brand kit, so the card carries the club's identity here the same
  // way it does in the meeting.
  const { kit: clubKit } = useClub();

  // The role the picker starts on: Standard Speech, unless this device or its
  // club removed it from the list. A <select> whose value is not among its
  // options shows the first option while the state keeps the removed role, and
  // START then finds no rules for it ("Please set timing rules first").
  const defaultRole = roleOptions.includes('Standard Speech') ? 'Standard Speech' : roleOptions[0] || 'Standard Speech';

  // An agenda row whose role is not one the user can pick (#91). The Agenda
  // tab highlights it and asks for the role; nothing here may load it, because
  // loading it would time the speaker under a role nobody chose.
  const needsRole = (item) => agendaItemNeedsRole(item, roleOptions);
  const askForRole = (item) =>
    showToast(`Pick a role for ${item.name || 'this speaker'} on the Agenda tab first`, 'warning');

  const [speakerName, setSpeakerName] = useState(currentSpeaker?.name || '');
  const [selectedRole, setSelectedRole] = useState(currentSpeaker?.role || defaultRole);
  const [customRules, setCustomRules] = useState({ ...DEFAULT_CUSTOM_RULES });
  const [timeInputMode, setTimeInputMode] = useState(loadTimeInputMode);
  const [showEditRulesModal, setShowEditRulesModal] = useState(false);
  const [showCardImagesModal, setShowCardImagesModal] = useState(false);
  const [showSoundsModal, setShowSoundsModal] = useState(false);
  const { lockReason: soundsLockReason } = useSoundsAccess();
  // Bumped on upload/reset so the tile and page background re-read the images.
  const [, setCardImagesGeneration] = useState(0);
  const [previewColor, setPreviewColor] = useState(null);
  const initializedRef = useRef(false);
  const isLocalNameEdit = useRef(false);

  // Custom card images load from IndexedDB asynchronously at startup; until
  // then a selected custom set resolves to the built-in fallback. Once they
  // are in, re-render the tile and repaint the page with whatever is showing.
  const shownStatusRef = useRef('blue');
  shownStatusRef.current = previewColor || currentStatus || 'blue';
  useEffect(() => {
    let cancelled = false;
    initCardImages().then(() => {
      if (cancelled) return;
      setCardImagesGeneration((generation) => generation + 1);
      setPageBackgroundFromStatus(shownStatusRef.current);
      preloadCardImages();
    });
    return () => { cancelled = true; };
  }, []);

  // The club's card set arrives, changes or goes away while the page is open.
  useEffect(() => subscribeCardImages(() => {
    setCardImagesGeneration((generation) => generation + 1);
    setPageBackgroundFromStatus(shownStatusRef.current);
    preloadCardImages();
  }), []);

  // On mount, seed the speaker. A "Time this" deep link (?role=...&name=...)
  // wins when nothing is loaded yet and the timer is idle; otherwise the
  // default role applies. A speaker that is already there (restored state)
  // is left alone. Either way the link params are consumed off the URL.
  useEffect(() => {
    if (initializedRef.current || !selectedRole || !roleRules || Object.keys(roleRules).length === 0) return;
    if (!currentSpeaker) {
      const linked = isRunning ? null : parseSpeakerFromSearch(window.location.search, roleOptions);
      if (linked) {
        setSpeakerName(linked.name);
        setSelectedRole(linked.role);
        setCurrentSpeaker({ name: linked.name, role: linked.role });
      } else {
        setCurrentSpeaker({ name: '', role: selectedRole });
      }
    }
    stripSpeakerParams();
    initializedRef.current = true;
  }, [roleRules, roleOptions, selectedRole, currentSpeaker, setCurrentSpeaker, isRunning]);

  useEffect(() => {
    if (currentSpeaker) {
      if (!isLocalNameEdit.current) {
        setSpeakerName(currentSpeaker.name || '');
      }
      isLocalNameEdit.current = false;
      setSelectedRole(currentSpeaker.role);
      if (currentSpeaker.role === 'Custom' && currentSpeaker.rules) {
        setCustomRules({ ...DEFAULT_CUSTOM_RULES, ...currentSpeaker.rules });
      }
    } else {
      setSpeakerName('');
      setSelectedRole(defaultRole);
    }
  }, [currentSpeaker]);

  // The selected role left the list (removed in Edit Rules, or by a club
  // publish): move to the default rather than leave START with no rules. Never
  // under a speech in progress, which carries its own rules on the speaker.
  //
  // Except for an agenda row that now needs a role: moving it to the default
  // would time that speaker under a role nobody picked, which is the guess #91
  // removed. Let go of the row instead, and say where its role is picked. The
  // suggestions and FINISH refuse such a row before it loads; this catches a
  // row whose role goes away while it is up.
  const speechActive = isRunning || elapsedTime > 0;
  useEffect(() => {
    if (speechActive || roleOptions.length === 0 || roleOptions.includes(selectedRole)) return;
    const activeItem = activeSpeakerId ? agenda.find((item) => item.id === activeSpeakerId) : null;
    if (activeItem && needsRole(activeItem)) {
      clearActiveSpeaker();
      setSpeakerName('');
      setSelectedRole(defaultRole);
      setCurrentSpeaker({ name: '', role: defaultRole });
      askForRole(activeItem);
      return;
    }
    setSelectedRole(defaultRole);
    setCurrentSpeaker({ name: speakerName || '', role: defaultRole });
  }, [speechActive, roleOptions, selectedRole, defaultRole, speakerName, setCurrentSpeaker, activeSpeakerId, agenda, clearActiveSpeaker, showToast]);

  useEffect(() => {
    if (selectedRole === 'Custom' && roleRules['Custom']) {
      setCustomRules({ ...DEFAULT_CUSTOM_RULES, ...roleRules['Custom'] });
    }
  }, [selectedRole, roleRules]);

  useEffect(() => {
    if (isRunning) setPreviewColor(null);
  }, [isRunning]);

  const handleSpeakerChange = (name) => {
    setSpeakerName(name || '');
    isLocalNameEdit.current = true;
    updateSpeakerName(name || '');
  };

  const handleSelectSuggestion = (item) => {
    if (needsRole(item)) {
      askForRole(item);
      return;
    }
    setSpeakerName(item.name);
    setSelectedRole(item.role);
    const rules = item.role === 'Custom' ? customRules : undefined;
    setCurrentSpeaker({ name: item.name, role: item.role, ...(rules && { rules }) });
  };

  const handleRoleChange = (role) => {
    setSelectedRole(role);
    const rules = role === 'Custom' ? customRules : undefined;
    setCurrentSpeaker({ name: speakerName || '', role, ...(rules && { rules }) });
    (window.requestIdleCallback || setTimeout)(() => trackEvent('speaker_role_changed', { role }));
  };

  const handleCustomRuleChange = (field, value) => {
    const newRules = { ...customRules, [field]: value };
    setCustomRules(newRules);
    if (selectedRole === 'Custom') {
      setCurrentSpeaker({ name: speakerName || '', role: 'Custom', rules: newRules });
    }
  };
  const formatTimeReadable = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    if (mins === 0) return `${secs} second${secs !== 1 ? 's' : ''}`;
    if (secs === 0) return `${mins} minute${mins !== 1 ? 's' : ''}`;
    return `${mins} min ${secs} sec`;
  };
  const roleExplanation = useMemo(() => {
    const rules = roleRules[selectedRole] || DEFAULT_ROLE_RULES[selectedRole] || DEFAULT_ROLE_RULES['Standard Speech'];
    return `Green: ${formatTimeReadable(rules.green)}, Yellow: ${formatTimeReadable(rules.yellow)}, Red: ${formatTimeReadable(rules.red)}`;
  }, [selectedRole, roleRules]);

  const handlePreviewColor = (color) => {
    if (color === previewColor) {
      setPreviewColor(null);
      setPageBackgroundFromStatus('blue');
    } else {
      setPreviewColor(color);
      setPageBackgroundFromStatus(color);
    }
  };

  const handleStart = () => {
    if (selectedRole === 'Custom') {
      if (customRules.green <= 0 || customRules.yellow <= customRules.green || customRules.red <= customRules.yellow) {
        showToast('Invalid timing rules. Green must be > 0, Yellow must be > Green, and Red must be > Yellow.', 'error');
        return;
      }
    }
    const rules = selectedRole === 'Custom' ? customRules : roleRules[selectedRole];
    if (!rules) {
      showToast('Please set timing rules first', 'warning');
      return;
    }
    setCurrentSpeaker({ name: speakerName || '', role: selectedRole, ...(selectedRole === 'Custom' && { rules }) });
    startTimer();
    (window.requestIdleCallback || setTimeout)(() => trackEvent('timer_started', { role: selectedRole, speaker_name: speakerName || '' }));
    onTimerStart?.();
  };

  const handleContinue = () => {
    startTimer();
    (window.requestIdleCallback || setTimeout)(() => trackEvent('timer_continued', { role: selectedRole, elapsed_time: elapsedTime }));
    onTimerStart?.();
  };
  const handleStop = () => {
    stopTimer();
    (window.requestIdleCallback || setTimeout)(() => trackEvent('timer_stopped', { role: selectedRole, elapsed_time: elapsedTime }));
  };
  const handleReset = () => {
    (window.requestIdleCallback || setTimeout)(() => trackEvent('timer_reset', { role: selectedRole, elapsed_time: elapsedTime }));
    resetTimer();
    setSpeakerName('');
  };
  const handleFinish = () => {
    const currentAgendaId = activeSpeakerId;
    finishCurrentSpeech();
    if (currentAgendaId) {
      const currentIndex = agenda.findIndex(item => item.id === currentAgendaId);
      const nextSpeaker = agenda.slice(currentIndex + 1).find(item => !item.completed);
      // Next up has no role the user picked (#91): leave them unloaded rather
      // than time them under whatever role is showing, and say why the running
      // order stopped. Not skipped either: the order is the club's.
      if (nextSpeaker && needsRole(nextSpeaker)) {
        askForRole(nextSpeaker);
      } else if (nextSpeaker) {
        loadSpeakerFromAgenda(nextSpeaker.id);
        setSpeakerName(nextSpeaker.name || '');
        setSelectedRole(nextSpeaker.role);
        return;
      }
    }
    setSpeakerName('');
  };

  return (
    <div className="p-4 space-y-4 relative">
      <SpeakerInput
        value={speakerName}
        onChange={handleSpeakerChange}
        onRoleChange={handleRoleChange}
        selectedRole={selectedRole}
        roleOptions={roleOptions}
        onEditRules={() => setShowEditRulesModal(true)}
        agendaItems={agenda}
        onSelectSuggestion={handleSelectSuggestion}
      />
      {selectedRole !== 'Custom' && (
        <p className="text-xs text-gray-500 mt-1">Timing rules: {roleExplanation}</p>
      )}
      {selectedRole === 'Custom' && (
        <div className="bg-gray-50 p-4 rounded-lg border border-gray-200 space-y-3">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold text-gray-700">Custom Timing Rules</h3>
            <TimeInputModeToggle mode={timeInputMode} onModeChange={(m) => { saveTimeInputMode(m); setTimeInputMode(m); }} />
          </div>
          <div className="flex flex-col items-center gap-2">
            <TimeInput layout="inline" label="Green" value={customRules.green} onChange={(v) => handleCustomRuleChange('green', v)} />
            <TimeInput layout="inline" label="Yellow" value={customRules.yellow} onChange={(v) => handleCustomRuleChange('yellow', v)} />
            <TimeInput layout="inline" label="Red" value={customRules.red} onChange={(v) => handleCustomRuleChange('red', v)} />
            <TimeInput layout="inline" label="Grace" value={customRules.graceAfterRed ?? DEFAULT_CUSTOM_RULES.graceAfterRed} onChange={(v) => handleCustomRuleChange('graceAfterRed', v)} />
          </div>
          {(customRules.yellow <= customRules.green || customRules.red <= customRules.yellow) && (
            <div className="text-xs text-red-600">Yellow &gt; Green, Red &gt; Yellow</div>
          )}
        </div>
      )}

      <TimerDisplay
        elapsedTime={elapsedTime}
        status={previewColor || currentStatus}
        rules={currentSpeaker?.rules}
        backgroundImage={getCardImageUrl(previewColor || currentStatus)}
        clubKit={clubKit}
        badgePlacement={clubKit ? clubBadgePlacement() : null}
      />

      {!isRunning && (
        <div className="flex items-center justify-center gap-3">
          <span className="text-xs text-gray-500">Preview:</span>
          {PREVIEW_COLORS.map(({ color, hex }) => (
            <button
              key={color}
              onClick={() => handlePreviewColor(color)}
              className={`w-8 h-8 rounded-full transition-all ${previewColor === color ? 'ring-2 ring-offset-2 ring-gray-400 scale-110' : 'opacity-70 hover:opacity-100'}`}
              style={{ backgroundColor: hex }}
            />
          ))}
          <button
            onClick={() => setShowCardImagesModal(true)}
            className="p-1.5 rounded-lg text-gray-500 hover:text-gray-700 hover:bg-gray-100 transition-colors"
            title="Customize card images"
            aria-label="Customize card images"
          >
            <Image className="h-4 w-4" />
          </button>
          {/* Shown even when locked, so free users can see what Pro adds. The
              modal still opens; its controls are what is locked. */}
          <button
            onClick={() => setShowSoundsModal(true)}
            className={`relative p-1.5 rounded-lg hover:bg-gray-100 transition-colors ${
              soundsLockReason ? 'text-gray-300 hover:text-gray-400' : 'text-gray-500 hover:text-gray-700'
            }`}
            title={soundsLockReason ? SOUNDS_LOCK_MESSAGES[soundsLockReason] : 'Sounds'}
            aria-label={soundsLockReason ? `Sounds (locked): ${SOUNDS_LOCK_MESSAGES[soundsLockReason]}` : 'Sounds'}
          >
            <Volume2 className="h-4 w-4" />
            {soundsLockReason && (
              <Lock className="absolute bottom-0.5 right-0.5 h-2.5 w-2.5 text-gray-500" aria-hidden="true" />
            )}
          </button>
        </div>
      )}

      <div className="space-y-2 pb-20">
        {isRunning ? (
          <div className="flex gap-2">
            <button onClick={handleStop} className="flex-1 bg-red-500 hover:bg-red-600 text-white font-semibold py-3 px-4 rounded-lg flex items-center justify-center gap-2">
              <Square className="h-5 w-5" /> STOP
            </button>
            <button onClick={handleFinish} className="flex-1 bg-blue-500 hover:bg-blue-600 text-white font-semibold py-3 px-4 rounded-lg">
              FINISH
            </button>
          </div>
        ) : elapsedTime === 0 ? (
          <>
            <div className="flex gap-2">
              <button onClick={handleStart} className="flex-1 bg-green-500 hover:bg-green-600 text-white font-semibold py-3 px-4 rounded-lg flex items-center justify-center gap-2">
                <Play className="h-5 w-5" /> START
              </button>
            </div>
            <div className="flex gap-2">
              <button onClick={handleReset} className="flex-1 bg-gray-500 hover:bg-gray-600 text-white font-semibold py-2 px-4 rounded-lg flex items-center justify-center gap-2">
                <RotateCcw className="h-4 w-4" /> RESET
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="flex gap-2">
              <button onClick={handleContinue} className="flex-1 bg-green-500 hover:bg-green-600 text-white font-semibold py-3 px-4 rounded-lg flex items-center justify-center gap-2">
                <Play className="h-5 w-5" /> CONTINUE
              </button>
            </div>
            <div className="flex gap-2">
              <button onClick={handleReset} className="flex-1 bg-gray-500 hover:bg-gray-600 text-white font-semibold py-2 px-4 rounded-lg flex items-center justify-center gap-2">
                <RotateCcw className="h-4 w-4" /> RESET
              </button>
              <button onClick={handleFinish} className="flex-1 bg-blue-500 hover:bg-blue-600 text-white font-semibold py-2 px-4 rounded-lg">
                FINISH
              </button>
            </div>
          </>
        )}
      </div>

      {showEditRulesModal && (
        <Suspense fallback={null}>
          <EditRulesModal isOpen={showEditRulesModal} onClose={() => setShowEditRulesModal(false)} />
        </Suspense>
      )}

      {showCardImagesModal && (
        <Suspense fallback={null}>
          <CardImagesModal
            isOpen={showCardImagesModal}
            onClose={() => setShowCardImagesModal(false)}
            onImagesChanged={() => {
              setCardImagesGeneration((generation) => generation + 1);
              // Repaint the page with the new artwork for whatever is showing,
              // and warm the other cards so the coming switches don't decode.
              setPageBackgroundFromStatus(previewColor || currentStatus || 'blue');
              preloadCardImages();
            }}
          />
        </Suspense>
      )}

      {showSoundsModal && (
        <Suspense fallback={null}>
          <SoundsModal isOpen={showSoundsModal} onClose={() => setShowSoundsModal(false)} />
        </Suspense>
      )}
    </div>
  );
});
