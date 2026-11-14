import { useState, useRef, useEffect, memo } from 'react';
import { Monitor, Camera, Maximize2, ChevronDown, Check, Image } from 'lucide-react';
import {
  OVERLAY_MODE_CARD,
  OVERLAY_MODE_CAMERA,
  OVERLAY_MODE_STAGE,
  isVideoOverlayMode,
} from '../utils/zoomSdk';

// Modes on one row left each button too small to read and gave no hint what any
// of them did. As a menu there is room for a name and a line of explanation,
// which these need: the difference between them is not something an icon conveys.
//
// Sharing and popping out used to be modes of their own, which put two nearly
// identical entries next to each other and forced the choice up front, before the
// organizer could see what either did. They are one stage now, with both offered
// as buttons once you are in it: the choice is made where its effect is visible,
// it can be changed without leaving, and a screen share is always something the
// organizer pressed rather than a consequence of picking a mode.
//
// They are not simultaneous — Zoom refuses to undock an app that is being shared
// — so the stage hides the window button while a share is running.
//
// Timer + Camera leads because it is the default: the color rides on the
// organizer's tile without taking their face away. Timer Only follows for
// anyone who prefers the color alone, and the full-screen timer comes last as
// the deliberate act it is — sharing or popping out a whole window.
export const OVERLAY_MODES = [
  {
    mode: OVERLAY_MODE_CAMERA,
    Icon: Camera,
    label: 'Timer + Camera',
    description: 'Color behind your face',
  },
  {
    mode: OVERLAY_MODE_CARD,
    Icon: Monitor,
    label: 'Timer Only',
    description: 'Color replaces your video',
  },
  {
    mode: OVERLAY_MODE_STAGE,
    Icon: Maximize2,
    label: 'Full-Screen Timer',
    description: 'Full-size timer to share or pop out',
  },
];

export const MODE_LABELS = Object.fromEntries(OVERLAY_MODES.map(({ mode, label }) => [mode, label]));

/**
 * Mode picker for the Live tab: the active mode plus a menu to change it.
 */
export default memo(function OverlayModeMenu({ value, onChange, revealFaceWhenIdle, onToggleRevealFaceWhenIdle, onCustomizeCards }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef(null);
  const menuRef = useRef(null);

  const active = OVERLAY_MODES.find((m) => m.mode === value) || OVERLAY_MODES[0];
  const ActiveIcon = active.Icon;

  useEffect(() => {
    if (!open) return undefined;
    const handleClickOutside = (e) => {
      if (
        menuRef.current && !menuRef.current.contains(e.target) &&
        buttonRef.current && !buttonRef.current.contains(e.target)
      ) {
        setOpen(false);
      }
    };
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const handleSelect = (mode) => {
    setOpen(false);
    if (mode !== value) onChange(mode);
  };

  return (
    <div className="relative">
      {/* Names the mode it is in rather than hiding it behind a hover. Which
          mode is running decides where the color goes — over your face, behind
          it, or nowhere near your camera — so it is the one thing worth reading
          at a glance, and the chevron is what says it can be changed. */}
      <button
        ref={buttonRef}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        className="flex items-center gap-1.5 pl-2 pr-1.5 py-1.5 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm font-medium transition-colors"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Display mode: ${active.label}. Change`}
      >
        <ActiveIcon className="h-4 w-4 flex-shrink-0 text-blue-600" />
        {active.label}
        <ChevronDown className={`h-3.5 w-3.5 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div
          ref={menuRef}
          role="menu"
          className="absolute right-0 z-20 mt-1 w-60 bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden"
        >
          {OVERLAY_MODES.map(({ mode, Icon, label, description }) => {
            const isActive = mode === value;
            return (
              <button
                key={mode}
                role="menuitemradio"
                aria-checked={isActive}
                onClick={() => handleSelect(mode)}
                className={`w-full flex items-start gap-2.5 px-3 py-2.5 text-left transition-colors ${
                  isActive ? 'bg-blue-50' : 'hover:bg-gray-50'
                }`}
              >
                <Icon className={`h-4 w-4 mt-0.5 flex-shrink-0 ${isActive ? 'text-blue-600' : 'text-gray-500'}`} />
                <span className="min-w-0 flex-1">
                  <span className={`block text-sm font-medium ${isActive ? 'text-blue-700' : 'text-gray-900'}`}>
                    {label}
                  </span>
                  <span className="block text-xs text-gray-500">{description}</span>
                </span>
                {isActive && <Check className="h-4 w-4 text-blue-600 flex-shrink-0 mt-0.5" />}
              </button>
            );
          })}

          {/* In every mode: the cards show on the video in the video modes and
              on the stage itself in stage mode, so the artwork is never moot. */}
          {onCustomizeCards && (
            <button
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onCustomizeCards();
              }}
              className="w-full flex items-start gap-2.5 px-3 py-2.5 text-left border-t border-gray-200 transition-colors hover:bg-gray-50"
            >
              <Image className="h-4 w-4 mt-0.5 flex-shrink-0 text-gray-500" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-gray-900">Card Images…</span>
                <span className="block text-xs text-gray-500">Upload your own card artwork</span>
              </span>
            </button>
          )}

          {/* Only for the video modes. The stage modes never touch the camera, so
              the setting would be a control that does nothing there. */}
          {isVideoOverlayMode(value) && (
            <label className="flex items-start gap-2.5 px-3 py-2.5 border-t border-gray-200 cursor-pointer hover:bg-gray-50">
              <input
                type="checkbox"
                checked={revealFaceWhenIdle}
                onChange={onToggleRevealFaceWhenIdle}
                className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 flex-shrink-0"
              />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-gray-900">Show my own background</span>
                <span className="block text-xs text-gray-500">
                  Between speeches. Zoom asks you to confirm each time
                </span>
              </span>
            </label>
          )}
        </div>
      )}
    </div>
  );
});
