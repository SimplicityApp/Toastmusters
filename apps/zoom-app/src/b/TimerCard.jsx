import { memo, useRef } from 'react';
import { Check, Pause, Play, RotateCcw } from 'lucide-react';
import { BREAK_ROLE, formatTime, getDisplaySeconds } from '@toastmaster-timer/shared';
import VideoPreviewLayer from '../components/VideoPreviewLayer';
import SpeakerPicker from './SpeakerPicker';
import RolePicker from './RolePicker';
import { CARD_PALETTE, PREVIEW_SWATCHES, cardStatusLine, rulesLine } from './format';

const BUTTON = 'flex items-center justify-center gap-2 rounded-xl transition-opacity disabled:cursor-not-allowed';

/**
 * Design B's timer card (the BCard board): the whole card takes the colour the
 * meeting sees. Speaker and role along the top, the rules under them, a 16:9
 * preview of the video with the count-up chip and club badge to drag, the big
 * clock and one status line, the preview swatches while nothing runs, and the
 * buttons for the state the timer is in.
 *
 * Draws only. Every action is a prop, wired to useLiveTimer by TimerTab.
 */
export default memo(function TimerCard({
  status,
  previewColor,
  elapsedTime,
  isRunning,
  rules,
  speakerName,
  selectedRole,
  roleOptions,
  roleRules,
  agenda,
  activeSpeakerId,
  needsRole,
  onSelectSpeaker,
  onAddSpeaker,
  onRenameSpeaker,
  onRoleChange,
  onEditRules,
  readoutPosition,
  readoutVisible,
  onReadoutPositionChange,
  onToggleReadoutVisible,
  onAdjustReadoutScale,
  clubKit,
  badgePlacement,
  badgeMoved,
  onBadgePlacementChange,
  onAdjustBadgeScale,
  onToggleBadgeVisible,
  onResetBadgePlacement,
  coachHint,
  onCoachSeen,
  videoOff,
  isClearingVideo,
  onPreviewColor,
  onStart,
  onStop,
  onContinue,
  onReset,
  onFinish,
}) {
  const insetRef = useRef(null);
  const colour = status || 'blue';
  const p = CARD_PALETTE[colour] || CARD_PALETTE.blue;
  const idle = !isRunning && elapsedTime === 0;
  const paused = !isRunning && elapsedTime > 0;
  const shownRules = rules || roleRules[selectedRole] || null;
  const showRulesLine = selectedRole !== 'Custom' && selectedRole !== BREAK_ROLE && shownRules;
  const displayTime = formatTime(getDisplaySeconds(elapsedTime, shownRules));
  const statusLine = cardStatusLine({ status: colour, rules: shownRules, isRunning, elapsedTime, previewColor, videoOff });

  const white = { background: '#ffffff', color: '#111827' };
  const ghost = { background: p.ghost, color: p.fg };
  const playColour = '#16a34a';

  return (
    <section
      aria-label="Timer"
      data-testid="timer-card"
      data-status={colour}
      className="flex flex-col gap-2.5 rounded-2xl p-3 transition-colors duration-300"
      style={{ background: p.bg, color: p.fg, boxShadow: `0 8px 20px ${p.shadow}` }}
    >
      <div className="flex gap-1.5">
        <SpeakerPicker
          value={speakerName}
          role={selectedRole}
          agendaItems={agenda}
          activeSpeakerId={activeSpeakerId}
          needsRole={needsRole}
          onSelectSpeaker={onSelectSpeaker}
          onAddSpeaker={onAddSpeaker}
          onRenameSpeaker={onRenameSpeaker}
          palette={p}
        />
        <RolePicker
          role={selectedRole}
          roleOptions={roleOptions}
          roleRules={roleRules}
          onChange={onRoleChange}
          onEditRules={onEditRules}
          palette={p}
        />
      </div>

      {showRulesLine && (
        <p className="-mt-0.5 flex flex-wrap items-center justify-center gap-x-1.5 text-[13px]">
          <span className="opacity-95">{rulesLine(shownRules)}</span>
          <button type="button" onClick={onEditRules} className="font-bold underline">
            Edit rules
          </button>
        </p>
      )}

      <div
        ref={insetRef}
        data-testid="video-preview"
        className={`relative flex aspect-video w-full flex-col items-center rounded-[10px] ${
          readoutPosition || clubKit ? 'justify-end pb-3' : 'justify-center'
        }`}
        style={{ background: p.inset }}
      >
        <VideoPreviewLayer
          containerRef={insetRef}
          displayTime={displayTime}
          readoutPosition={readoutPosition}
          onReadoutPositionChange={onReadoutPositionChange}
          readoutVisible={readoutVisible}
          onToggleReadoutVisible={onToggleReadoutVisible}
          onAdjustReadoutScale={onAdjustReadoutScale}
          clubKit={clubKit}
          badgePlacement={badgePlacement}
          badgeMoved={badgeMoved}
          onBadgePlacementChange={onBadgePlacementChange}
          onAdjustBadgeScale={onAdjustBadgeScale}
          onToggleBadgeVisible={onToggleBadgeVisible}
          onResetBadgePlacement={onResetBadgePlacement}
          revealControls="hover"
          chipHint={coachHint}
          onChipEngaged={onCoachSeen}
        />
        <div
          data-testid="timer-display"
          className="font-mono text-[56px] font-bold leading-none tracking-[0.03em]"
        >
          {displayTime}
        </div>
        {statusLine && (
          // No opacity here: a translucent block is its own stacking context,
          // painted after the chip and badge, and it took their − / + clicks
          // whenever they sat over it (2026-11-16 Zoom run, NL-04).
          <div data-testid="timer-status" className="mt-1.5 px-2 text-center text-[13px]">
            {statusLine}
          </div>
        )}
      </div>

      {!isRunning && (
        <div className="flex items-center justify-center gap-2 text-xs">
          <span className="opacity-90">Preview on video</span>
          {PREVIEW_SWATCHES.map(({ color, label, bg }) => (
            <button
              key={color}
              type="button"
              onClick={() => onPreviewColor(color)}
              disabled={videoOff}
              aria-label={`Preview ${label.toLowerCase()} on your video`}
              aria-pressed={previewColor === color}
              className={`h-[26px] w-[26px] rounded-full p-0 transition-transform disabled:opacity-40 ${previewColor === color ? 'scale-110' : ''}`}
              style={{ background: bg, border: `2px solid ${previewColor === color ? '#ffffff' : p.ring}` }}
            />
          ))}
        </div>
      )}

      {idle && (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onStart}
            disabled={videoOff}
            className={`${BUTTON} h-[52px] flex-1 text-[17px] font-extrabold disabled:opacity-50`}
            style={videoOff ? ghost : white}
          >
            <Play className="h-[18px] w-[18px]" fill={videoOff ? 'currentColor' : playColour} stroke="none" aria-hidden="true" />
            Start
          </button>
          <button
            type="button"
            onClick={onReset}
            disabled={isClearingVideo}
            aria-label="Reset"
            className={`${BUTTON} h-[52px] w-[52px] flex-shrink-0 disabled:opacity-50`}
            style={ghost}
          >
            <RotateCcw className="h-[18px] w-[18px]" aria-hidden="true" />
          </button>
        </div>
      )}

      {isRunning && (
        <div className="grid grid-cols-2 gap-2">
          <button type="button" onClick={onStop} className={`${BUTTON} h-[52px] text-base font-bold`} style={ghost}>
            <Pause className="h-4 w-4" fill="currentColor" stroke="none" aria-hidden="true" />
            Stop
          </button>
          <button type="button" onClick={onFinish} className={`${BUTTON} h-[52px] text-base font-extrabold`} style={white}>
            <Check className="h-4 w-4" strokeWidth={2.6} aria-hidden="true" />
            Finish
          </button>
        </div>
      )}

      {paused && (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={onContinue}
            disabled={videoOff}
            className={`${BUTTON} h-[52px] text-[17px] font-extrabold disabled:opacity-50`}
            style={videoOff ? ghost : white}
          >
            <Play className="h-[18px] w-[18px]" fill={videoOff ? 'currentColor' : playColour} stroke="none" aria-hidden="true" />
            Continue
          </button>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={onReset}
              disabled={isClearingVideo}
              className={`${BUTTON} h-11 text-[15px] font-bold disabled:opacity-50`}
              style={ghost}
            >
              <RotateCcw className="h-4 w-4" aria-hidden="true" />
              Reset
            </button>
            <button type="button" onClick={onFinish} className={`${BUTTON} h-11 text-[15px] font-extrabold`} style={white}>
              <Check className="h-4 w-4" strokeWidth={2.6} aria-hidden="true" />
              Finish
            </button>
          </div>
        </div>
      )}
    </section>
  );
});
