import { memo } from 'react';
import { formatTime, getPhaseInfo, formatPhaseText } from '@toastmaster-timer/shared';
import ClubBadge, { ClubBadgeLayer } from '@toastmaster-timer/ui/ClubBadge';

export default memo(function TimerDisplay({ elapsedTime, status, rules, backgroundImage, clubKit, badgePlacement }) {
  const phaseInfo = rules ? getPhaseInfo(elapsedTime, rules, status) : null;
  const phaseText = phaseInfo ? formatPhaseText(phaseInfo) : '';
  const statusColors = { blue: 'bg-blue-500', green: 'bg-green-500', yellow: 'bg-yellow-500', red: 'bg-red-500' };
  const bgColor = statusColors[status] || 'bg-blue-500';
  const textColor = 'text-white';
  const timerTextStyle = { textShadow: '0 2px 4px rgba(0,0,0,0.5), 0 4px 8px rgba(0,0,0,0.3)' };
  const phaseTextStyle = { textShadow: '0 1px 2px rgba(0,0,0,0.5)' };
  // A custom card image covers the tile; the flat status color stays
  // underneath as the fallback while it paints or if it fails to.
  const tileStyle = backgroundImage
    ? { backgroundImage: `url("${backgroundImage}")`, backgroundSize: 'cover', backgroundPosition: 'center' }
    : undefined;

  return (
    <div style={tileStyle} className={`relative w-full aspect-square rounded-lg ${bgColor} flex flex-col items-center justify-center shadow-lg transition-colors duration-300`}>
      {/* The club's badge, at the placement the club published. The browser app
          pushes nothing into a meeting, so this card *is* the surface and the
          badge is simply drawn on it. */}
      {clubKit?.showOnCards && badgePlacement && (
        <ClubBadgeLayer>
          <ClubBadge
            name={clubKit.name}
            primaryColor={clubKit.primaryColor}
            logoUrl={clubKit.logoUrl}
            placement={badgePlacement}
          />
        </ClubBadgeLayer>
      )}
      <div className={`${textColor} text-5xl sm:text-6xl font-mono font-bold mb-4`} style={timerTextStyle}>
        {formatTime(elapsedTime)}
      </div>
      {phaseText && (
        <div className={`${textColor} text-base sm:text-lg font-medium px-2 text-center`} style={phaseTextStyle}>
          {phaseText}
        </div>
      )}
    </div>
  );
});
