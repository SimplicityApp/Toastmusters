import { memo } from 'react';
import {
  Play,
  Square,
  RotateCcw,
  X,
  Eye,
  EyeOff,
  ScreenShare,
  ScreenShareOff,
  PictureInPicture2,
  Minimize2,
} from 'lucide-react';
import { formatTime, getPhaseInfo, formatPhaseTextFor, getDisplaySeconds } from '@toastmaster-timer/shared';
import ClubBadge, { ClubBadgeLayer } from '@toastmaster-timer/ui/ClubBadge';
import { getBackgroundUrl } from '../utils/zoomSdk';
import StageSpeakerPicker from './StageSpeakerPicker';

// Shown underneath the branded PNG, so the color signal is already correct while
// the image loads and stays correct if it fails to load at all.
const STATUS_COLORS = {
  blue: 'bg-blue-500',
  green: 'bg-green-500',
  yellow: 'bg-yellow-500',
  red: 'bg-red-500',
};

// The controls are visible to the speaker along with everything else on the
// shared screen, so they are outlined rather than filled. A solid white button
// pulls the eye harder than the color signal it sits under, which is backwards:
// the organizer knows where the bar is and only needs to find it, while the
// speaker should be able to look past it. Contrast comes from the dark scrim
// behind them, so these read the same against all four status colors.
const BUTTON_BASE =
  'py-2.5 px-4 rounded-lg text-sm font-medium tracking-wide text-white border transition-colors flex items-center justify-center gap-2';
const PRIMARY_BUTTON = `flex-1 ${BUTTON_BASE} bg-white/15 hover:bg-white/25 border-white/40`;
const SECONDARY_BUTTON = `flex-1 ${BUTTON_BASE} bg-transparent hover:bg-white/15 border-white/20 text-white/85`;
const ICON_BUTTON = `${BUTTON_BASE} bg-transparent hover:bg-white/15 border-white/20 text-white/85`;

/**
 * Full-panel timer display: the stage.
 *
 * Unlike card and camera mode, nothing here is pushed through the video
 * pipeline. This *is* what gets seen, and by whom is the organizer's choice from
 * the two buttons in the header — share it into the meeting, pop it into its own
 * window for a second screen, either, both, or neither.
 *
 * The whole panel is covered on purpose: once shared, every pixel of the app is
 * broadcast, so leaving the agenda or the debug panel visible would put them in
 * front of the meeting. For the same reason the controls live in here rather than
 * underneath — the organizer has to be able to run the timer, and to stop
 * sharing, without exposing anything else.
 */
export default memo(function TimerStage({
  status,
  elapsedTime,
  rules,
  speakerName,
  role,
  isRunning,
  onStart,
  onContinue,
  onStop,
  onReset,
  onFinish,
  onExit,
  clockHidden,
  onToggleClock,
  isSharing,
  onToggleShare,
  isPoppedOut,
  onTogglePopout,
  canPopout,
  onSpeakerNameChange,
  agendaItems,
  activeSpeakerId,
  onSelectSpeaker,
  onAddSpeaker,
  onRenameSpeaker,
  clubKit,
  badgePlacement,
}) {
  const phaseInfo = rules ? getPhaseInfo(elapsedTime, rules, status) : null;
  const phaseText = phaseInfo ? formatPhaseTextFor(phaseInfo, rules) : '';
  const bgColor = STATUS_COLORS[status] || STATUS_COLORS.blue;

  const textShadow = { textShadow: '0 2px 4px rgba(0,0,0,0.5), 0 4px 8px rgba(0,0,0,0.3)' };

  // The same branded PNGs card and camera mode push into the video pipeline, so a
  // club sees one consistent visual whichever mode it settles on.
  //
  // Two layers, because the stage is rarely the 16:9 the asset was drawn at. A
  // lone 'contain' leaves flat Tailwind-colored bands down the sides that do not
  // match the artwork's own blue, and a lone 'cover' crops the wordmark away. So:
  // a blurred 'cover' copy fills the frame edge to edge, and the crisp 'contain'
  // copy sits on top with the logo intact. The margins end up as soft artwork
  // rather than a mismatched slab of color. Scaled past the edges so the blur has
  // pixels to sample instead of fading to transparent.
  const backgroundUrl = getBackgroundUrl(status);
  const backdropLayer = {
    backgroundImage: `url("${backgroundUrl}")`,
    backgroundSize: 'cover',
    backgroundPosition: 'center',
    filter: 'blur(28px)',
    transform: 'scale(1.15)',
  };
  const artworkLayer = {
    backgroundImage: `url("${backgroundUrl}")`,
    backgroundSize: 'contain',
    backgroundPosition: 'center',
    backgroundRepeat: 'no-repeat',
  };

  return (
    <div
      className={`fixed inset-0 z-50 ${bgColor} flex flex-col transition-colors duration-300`}
      data-testid="timer-stage"
    >
      {/* Backdrops paint under everything; the flat status color behind them is
          the fallback for an image that never loads. */}
      <div aria-hidden className="absolute inset-0 pointer-events-none" style={backdropLayer} />
      <div aria-hidden className="absolute inset-0 pointer-events-none" style={artworkLayer} />

      {/* The club's badge, on the same {x, y, scale} the video modes composite
          it at, so it lands in the same relative spot whichever mode a club
          settles on. DOM rather than canvas here because the stage *is* the
          shared surface — nothing is pushed through the video pipeline — and
          above the artwork for the same reason the readout is. */}
      {clubKit?.showOnCards && (
        <ClubBadgeLayer>
          <ClubBadge
            name={clubKit.name}
            primaryColor={clubKit.primaryColor}
            logoUrl={clubKit.logoUrl}
            placement={badgePlacement}
          />
        </ClubBadgeLayer>
      )}

      <div className="relative p-4 space-y-2">
        <div className="flex items-start gap-2">
          {/* Editable here, not just on the panel: once the stage is up it covers
              the panel entirely, and the organizer still has to name each speaker
              as the meeting moves on — including jumping the running order and
              fixing a name that came in wrong. */}
          <div className="min-w-0 flex-1">
            <StageSpeakerPicker
              value={speakerName}
              onChange={onSpeakerNameChange}
              role={role}
              agendaItems={agendaItems}
              activeSpeakerId={activeSpeakerId}
              onSelectSpeaker={onSelectSpeaker}
              onAddSpeaker={onAddSpeaker}
              onRenameSpeaker={onRenameSpeaker}
            />
          </div>
          <button
            onClick={onExit}
            className="p-2 rounded-lg bg-black/20 hover:bg-black/30 transition-colors flex-shrink-0"
            data-tooltip="Close the timer stage"
            data-tooltip-direction="down-left"
            aria-label="Close the timer stage"
          >
            <X className="h-5 w-5 text-white" />
          </button>
        </div>

        <div className="flex items-center justify-between gap-2">
          {role ? (
            <span className="text-white/80 text-sm truncate min-w-0" style={textShadow}>
              {role}
            </span>
          ) : (
            <span />
          )}

          <div className="flex items-center gap-2 flex-shrink-0">
            {/* Labelled, not just an icon with a tooltip: this is the one control
                here with an audience, and whether the meeting can see the timer is
                the first thing an organizer needs to know without hovering. It
                reads as on rather than merely available for the same reason. */}
            <button
              onClick={onToggleShare}
              className={`flex items-center gap-1.5 pl-2.5 pr-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                isSharing ? 'bg-white text-blue-700 hover:bg-white/90' : 'bg-black/25 text-white hover:bg-black/35'
              }`}
              aria-label={isSharing ? 'Stop sharing the timer' : 'Screenshare the timer'}
              aria-pressed={isSharing}
            >
              {isSharing ? (
                <ScreenShareOff className="h-4 w-4 flex-shrink-0" />
              ) : (
                <ScreenShare className="h-4 w-4 flex-shrink-0" />
              )}
              {isSharing ? 'Stop sharing' : 'Screenshare'}
            </button>

            {/* Desktop only, and never while sharing: Zoom refuses to undock an
                app that is being shared, so offering it would only ever produce
                an error. Hidden rather than disabled — where appPopout was not
                granted at all, a permanently dead button invites the same click
                forever. */}
            {canPopout && !isSharing && (
              <button
                onClick={onTogglePopout}
                className="p-2 rounded-lg bg-black/25 hover:bg-black/35 transition-colors"
                data-tooltip={isPoppedOut ? 'Merge back to the main window' : 'Open in its own window'}
                data-tooltip-direction="down-left"
                aria-label={isPoppedOut ? 'Merge back to the main window' : 'Open in its own window'}
                aria-pressed={isPoppedOut}
              >
                {isPoppedOut ? (
                  <Minimize2 className="h-5 w-5 text-white" />
                ) : (
                  <PictureInPicture2 className="h-5 w-5 text-white" />
                )}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Deliberately empty: the color is the signal. A speaker watching a shared
          screen should be reading green/yellow/red the way they would read timing
          cards in the room, not a clock counting at them. */}
      <div className="relative flex-1 min-h-0" />

      {/* Organizer instrumentation, grouped at the bottom. Small on purpose:
          readable to whoever is running the timer, easy for the speaker to
          ignore. The scrim has to be this dark because white-on-yellow is the
          worst of the four states and the readout must hold up in all of them. */}
      <div className="relative p-4 space-y-2 bg-black/35">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <button
              onClick={onToggleClock}
              className="p-1 -m-1 rounded text-white/70 hover:text-white transition-colors flex-shrink-0"
              aria-label={clockHidden ? 'Show countdown' : 'Hide countdown'}
              aria-pressed={clockHidden}
              title={clockHidden ? 'Show countdown' : 'Hide countdown'}
            >
              {clockHidden ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
            {/* Hidden with invisible rather than unmounted: the bar keeps its
                height and the phase text keeps its position, so toggling does not
                make the shared screen jump. */}
            <span
              className={`text-white font-mono text-xl tabular-nums ${clockHidden ? 'invisible' : ''}`}
              style={textShadow}
              aria-hidden={clockHidden}
            >
              {formatTime(getDisplaySeconds(elapsedTime, rules))}
            </span>
          </div>
          {phaseText && (
            <span className="text-white/85 text-xs truncate" style={textShadow}>
              {phaseText}
            </span>
          )}
        </div>
        {isRunning ? (
          <div className="flex gap-2">
            <button onClick={onStop} className={PRIMARY_BUTTON}>
              <Square className="h-4 w-4" />
              STOP
            </button>
            <button onClick={onFinish} className={SECONDARY_BUTTON}>
              FINISH
            </button>
          </div>
        ) : (
          <div className="flex gap-2">
            <button onClick={elapsedTime === 0 ? onStart : onContinue} className={PRIMARY_BUTTON}>
              <Play className="h-4 w-4" />
              {elapsedTime === 0 ? 'START' : 'CONTINUE'}
            </button>
            <button onClick={onReset} className={ICON_BUTTON} aria-label="Reset">
              <RotateCcw className="h-4 w-4" />
            </button>
            {elapsedTime > 0 && (
              <button onClick={onFinish} className={SECONDARY_BUTTON}>
                FINISH
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
});
