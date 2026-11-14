import { memo, useRef } from 'react';
import { formatTime, getPhaseInfo, formatPhaseTextFor, getDisplaySeconds } from '@toastmaster-timer/shared';
import VideoPreviewLayer from './VideoPreviewLayer';

export default memo(function TimerDisplay({
  elapsedTime,
  status,
  rules,
  readoutPosition,
  onReadoutPositionChange,
  readoutVisible,
  onToggleReadoutVisible,
  onAdjustReadoutScale,
  clubKit,
  badgePlacement,
  badgeMoved,
  onBadgePlacementChange,
  onAdjustBadgeScale,
  onToggleBadgeVisible,
  onResetBadgePlacement,
}) {
  const phaseInfo = rules ? getPhaseInfo(elapsedTime, rules, status) : null;
  const phaseText = phaseInfo ? formatPhaseTextFor(phaseInfo, rules) : '';
  // Counts up for a speech, down for a break — everywhere this card shows a
  // clock, including the drag badge, which mirrors the pushed readout.
  const displayTime = formatTime(getDisplaySeconds(elapsedTime, rules));

  const containerRef = useRef(null);

  // Background color based on status
  const statusColors = {
    blue: 'bg-blue-500',
    green: 'bg-green-500',
    yellow: 'bg-yellow-500',
    red: 'bg-red-500',
  };

  const bgColor = statusColors[status] || 'bg-blue-500';

  // Text color and shadow based on status
  // All colored backgrounds use white text with shadow
  const textColor = 'text-white';

  // Enhanced shadow styles for better contrast
  const timerTextStyle = {
    textShadow: '0 2px 4px rgba(0,0,0,0.5), 0 4px 8px rgba(0,0,0,0.3)',
  };

  const phaseTextStyle = {
    textShadow: '0 1px 2px rgba(0,0,0,0.5)',
  };

  return (
    <div
      ref={containerRef}
      className={`relative w-full aspect-square rounded-lg ${bgColor} flex flex-col items-center justify-center shadow-lg transition-colors duration-300`}
    >
      <div
        data-testid="timer-display"
        className={`${textColor} text-5xl sm:text-6xl font-mono font-bold mb-4`}
        style={timerTextStyle}
      >
        {displayTime}
      </div>
      {phaseText && (
        <div
          className={`${textColor} text-base sm:text-lg font-medium px-2 text-center`}
          style={phaseTextStyle}
        >
          {phaseText}
        </div>
      )}

      {/* The count-up chip and the club badge, each dragged, sized and hidden
          right on the preview. */}
      <VideoPreviewLayer
        containerRef={containerRef}
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
      />
    </div>
  );
});
