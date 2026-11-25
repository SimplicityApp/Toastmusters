import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BREAK_ROLE,
  CLUB_CARD_SET_ID,
  DEFAULT_CARD_SETS,
  DEFAULT_CUSTOM_RULES,
  activeCardSetId,
  agendaItemNeedsRole,
  getCardImageSettings,
  hasOwnBackground,
  loadClubCards,
  saveTimeInputMode,
} from '@toastmaster-timer/shared';
import { useLiveTimer } from '../hooks/useLiveTimer';
import { useTimer } from '../context/TimerContext';
import { useToast } from '../context/ToastContext';
import { useSoundSettings } from '../hooks/useSounds';
import { isClubBadgeMoved, isVideoOverlayMode, OVERLAY_MODE_CARD } from '../utils/zoomSdk';
import TimerStage from '../components/TimerStage';
import TimerCard from './TimerCard';
import LookRows, { VIDEO_MODE_NOTES } from './LookRows';
import { BetweenSheet, CardsSheet, SoundsSheet, VideoSheet } from './LookSheets';
import { BreakMusicRow, BreakPanel, CustomTimesPanel, FinishNotice, UpNext, VideoOffNotice } from './TimerPanels';


/** Device-local: the "Drag me to move" note under the chip shows until it has been used once. */
export const COACH_SEEN_KEY = 'toastmaster_b_coach_seen';

function readCoachSeen() {
  try {
    return localStorage.getItem(COACH_SEEN_KEY) === '1';
  } catch {
    return true;
  }
}

/** The name of the card set on show, as the Cards sheet lists it. */
function cardSetLabel(clubLabel) {
  const id = activeCardSetId();
  if (id === CLUB_CARD_SET_ID) return loadClubCards()?.label || `${clubLabel || 'Club'} cards`;
  const builtIn = DEFAULT_CARD_SETS.find((set) => set.id === id);
  if (builtIn) return builtIn.label;
  const index = getCardImageSettings().customSets.findIndex((set) => set.id === id);
  return index >= 0 ? `Custom ${index + 1}` : DEFAULT_CARD_SETS[0].label;
}

function soundsNote({ cues, music }) {
  if (cues && music) return 'Chime + music';
  if (cues) return 'Chime on';
  if (music) return 'Music on';
  return 'Off';
}

/** The agenda row after the one on the timer that is still to speak. */
function nextAgendaRow(agenda, activeSpeakerId) {
  const index = activeSpeakerId ? agenda.findIndex((item) => item.id === activeSpeakerId) : -1;
  return agenda.slice(index + 1).find((item) => !item.completed && item.id !== activeSpeakerId) || null;
}

/**
 * Design B's Timer tab (boards B-T01 to B-T15): the timer card, what is next,
 * and the "Look & sound" rows with their sheets. All of the timer's behaviour,
 * the video included, comes from useLiveTimer, the same hook today's Live tab
 * draws; this view adds no video logic of its own.
 *
 * @param {{clearRequest: number, onGoToAgenda: () => void, onOpenRules: () => void}} props
 *   `clearRequest` bumps when the ⋯ menu asks to clear the timer from the video;
 *   `onOpenRules` opens the shell's Roles & timing rules.
 */
export default function TimerTab({ clearRequest = 0, onGoToAgenda, onOpenRules }) {
  const t = useLiveTimer();
  const { roleRules } = useTimer();
  const { showToast } = useToast();
  const soundSettings = useSoundSettings();
  const [sheet, setSheet] = useState(null);
  const [coachSeen, setCoachSeen] = useState(readCoachSeen);
  const [finishNotice, setFinishNotice] = useState(null);
  const [backgroundGeneration, setBackgroundGeneration] = useState(0);

  const needsRole = (item) => agendaItemNeedsRole(item, t.roleOptions);
  const videoOverlay = isVideoOverlayMode(t.overlayMode);
  const videoOff = t.videoState === false;
  const status = t.previewColor || t.currentStatus;

  // The ⋯ menu's clear, once per request, including one made before this tab
  // was showing (the menu switches here first).
  const handledClear = useRef(0);
  useEffect(() => {
    if (clearRequest > handledClear.current) {
      handledClear.current = clearRequest;
      t.handleClearVideo();
    }
    // Only a new request should run it, not a re-render with new handlers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearRequest]);

  // The after-Finish note goes once anything new is under way.
  useEffect(() => {
    if (t.isRunning || t.activeSpeakerId) setFinishNotice(null);
  }, [t.isRunning, t.activeSpeakerId]);

  const markCoachSeen = () => {
    if (coachSeen) return;
    setCoachSeen(true);
    try {
      localStorage.setItem(COACH_SEEN_KEY, '1');
    } catch {
      // Storage refused: the note comes back next time, which is harmless.
    }
  };

  const handleFinish = () => {
    const finishedName = t.speakerName;
    const wasBreak = Boolean(t.currentSpeaker?.rules?.countdown);
    const next = t.activeSpeakerId && !wasBreak ? nextAgendaRow(t.agenda, t.activeSpeakerId) : null;
    t.handleFinish();
    if (next && needsRole(next)) setFinishNotice({ finishedName, nextName: next.name });
    markCoachSeen();
  };

  const handleModeSelect = async (mode) => {
    setSheet(null);
    await t.handleModeSwitch(mode);
    if (mode === OVERLAY_MODE_CARD) {
      showToast('Timer only: the colour replaces your camera until you clear it.', 'success');
    }
  };

  const changeTimeMode = (mode) => {
    saveTimeInputMode(mode);
    t.setTimeInputMode(mode);
  };

  const upNext = useMemo(() => nextAgendaRow(t.agenda, t.activeSpeakerId), [t.agenda, t.activeSpeakerId]);
  // Recomputed when the artwork changes (the hook bumps cardImagesGeneration)
  // and when the club's set comes or goes.
  const cards = useMemo(
    () => cardSetLabel(t.clubKit?.name),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t.clubKit?.name, t.cardImagesGeneration, sheet]
  );
  const between = useMemo(
    () => (!t.revealFaceWhenIdle ? 'Timer card' : hasOwnBackground() ? 'My background' : 'My video'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t.revealFaceWhenIdle, backgroundGeneration, t.cardImagesGeneration, sheet]
  );

  const idle = !t.isRunning && t.elapsedTime === 0;
  const isBreak = t.selectedRole === BREAK_ROLE;
  const isCustom = t.selectedRole === 'Custom';

  return (
    <div className="relative flex flex-col gap-3.5 px-3 pb-6 pt-1">
      {/* The stage covers the whole panel: in share mode every pixel is
          broadcast, so nothing else may show. Restyled in Phase 3. */}
      {!videoOverlay && (
        <TimerStage
          status={status}
          elapsedTime={t.elapsedTime}
          rules={t.currentSpeaker?.rules}
          speakerName={t.speakerName}
          role={t.roleOnClock}
          isRunning={t.isRunning}
          onStart={t.handleStart}
          onContinue={t.handleContinue}
          onStop={t.handleStop}
          onReset={t.handleReset}
          onFinish={handleFinish}
          onExit={() => t.handleModeSwitch(OVERLAY_MODE_CARD)}
          clockHidden={t.stageClockHidden}
          onToggleClock={t.handleToggleStageClock}
          isSharing={t.isSharing}
          onToggleShare={t.handleToggleShare}
          isPoppedOut={t.isPoppedOut}
          onTogglePopout={t.handleTogglePopout}
          canPopout={t.canPopout}
          onSpeakerNameChange={t.handleSpeakerChange}
          agendaItems={t.agenda}
          activeSpeakerId={t.activeSpeakerId}
          onSelectSpeaker={t.handleSelectAgendaSpeaker}
          speakerEntry={t.speakerEntry}
          clubKit={t.clubKit}
          badgePlacement={t.badgePlacement}
        />
      )}

      {videoOff && <VideoOffNotice onTurnOn={t.handleTurnVideoOn} busy={t.isEnablingVideo} />}

      <TimerCard
        status={status}
        previewColor={t.previewColor}
        elapsedTime={t.elapsedTime}
        isRunning={t.isRunning}
        rules={t.currentSpeaker?.rules}
        speakerName={t.speakerName}
        selectedRole={t.selectedRole}
        roleOptions={t.roleOptions}
        roleRules={roleRules}
        agenda={t.agenda}
        activeSpeakerId={t.activeSpeakerId}
        needsRole={needsRole}
        onSelectSpeaker={t.handleSelectAgendaSpeaker}
        onSpeakerChange={t.handleSpeakerChange}
        speakerEntry={t.speakerEntry}
        onRoleChange={t.handleRoleChange}
        onEditRules={onOpenRules}
        readoutPosition={videoOverlay ? t.readoutPosition : null}
        readoutVisible={t.readoutVisible}
        onReadoutPositionChange={t.handleReadoutPositionChange}
        onToggleReadoutVisible={t.handleToggleReadoutVisible}
        onAdjustReadoutScale={t.handleAdjustReadoutScale}
        clubKit={t.badgeOnCards ? t.clubKit : null}
        badgePlacement={t.badgePlacement}
        badgeMoved={isClubBadgeMoved()}
        onBadgePlacementChange={t.handleBadgePlacementChange}
        onAdjustBadgeScale={t.handleAdjustBadgeScale}
        onToggleBadgeVisible={t.handleToggleBadgeVisible}
        onResetBadgePlacement={t.handleResetBadgePlacement}
        coachHint={!coachSeen && videoOverlay ? 'Drag me to move. Point at me to resize or hide.' : null}
        onCoachSeen={markCoachSeen}
        videoOff={videoOff}
        isClearingVideo={t.isClearingVideo}
        onPreviewColor={t.handlePreviewColor}
        onStart={() => {
          markCoachSeen();
          t.handleStart();
        }}
        onStop={t.handleStop}
        onContinue={t.handleContinue}
        onReset={t.handleReset}
        onFinish={handleFinish}
      />

      {isBreak && idle && (
        <BreakPanel
          seconds={t.breakSeconds}
          explanation={t.breakExplanation}
          mode={t.timeInputMode}
          onModeChange={changeTimeMode}
          onChange={t.handleBreakDurationChange}
        />
      )}
      <BreakMusicRow isRunning={t.isRunning} role={t.selectedRole} />
      {isCustom && idle && (
        <CustomTimesPanel
          rules={{ ...DEFAULT_CUSTOM_RULES, ...t.customRules }}
          mode={t.timeInputMode}
          onModeChange={changeTimeMode}
          onChange={t.handleCustomRuleChange}
        />
      )}

      {finishNotice ? (
        <FinishNotice
          finishedName={finishNotice.finishedName}
          nextName={finishNotice.nextName}
          onPickRole={onGoToAgenda}
          onDismiss={() => setFinishNotice(null)}
        />
      ) : (
        !isBreak && <UpNext item={upNext} needsRole={upNext ? needsRole(upNext) : false} />
      )}

      <LookRows
        video={VIDEO_MODE_NOTES[t.overlayMode] || VIDEO_MODE_NOTES.camera}
        cards={cards}
        sounds={soundsNote(soundSettings)}
        soundsLocked={Boolean(t.soundsLockReason)}
        between={between}
        onOpen={setSheet}
      />

      <VideoSheet
        open={sheet === 'video'}
        onClose={() => setSheet(null)}
        overlayMode={t.overlayMode}
        onSelect={handleModeSelect}
        onClear={async () => {
          setSheet(null);
          await t.handleClearVideo();
        }}
        isClearing={t.isClearingVideo}
      />
      <CardsSheet
        open={sheet === 'cards'}
        onClose={() => setSheet(null)}
        onImagesChanged={() => t.setCardImagesGeneration((generation) => generation + 1)}
      />
      <SoundsSheet open={sheet === 'sounds'} onClose={() => setSheet(null)} />
      <BetweenSheet
        open={sheet === 'between'}
        onClose={() => setSheet(null)}
        revealFaceWhenIdle={t.revealFaceWhenIdle}
        onChoose={(reveal) => reveal !== t.revealFaceWhenIdle && t.handleToggleRevealFaceWhenIdle()}
        onBackgroundChanged={() => setBackgroundGeneration((generation) => generation + 1)}
      />
    </div>
  );
}
