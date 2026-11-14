import { useEffect, useRef } from 'react';
import { cueForStatusChange, shouldPlayBreakMusic } from '@toastmaster-timer/shared';
import { useTimer, useTimerTick } from '../context/TimerContext';
import { soundEngine, useSoundSettings, useSoundsAccess } from '../hooks/useSounds';

/**
 * Plays the card-change chime and break music. Renders nothing.
 *
 * Mounted beside the tabs rather than in the Live tab, so the sound carries on
 * while the timer looks at the agenda or the report mid-speech.
 */
export default function TimerSounds() {
  const { currentStatus, isRunning } = useTimerTick();
  const { currentSpeaker } = useTimer();
  const settings = useSoundSettings();
  const { usable } = useSoundsAccess();
  const previousStatus = useRef(currentStatus);
  const wanted = usable && (settings.cues || settings.music);

  // Browsers only let audio start after a click. Start is one, but create the
  // context on any click so the first chime is not the one that gets eaten.
  useEffect(() => {
    if (!wanted) return undefined;
    const unlock = () => soundEngine.unlock();
    document.addEventListener('pointerdown', unlock, true);
    return () => document.removeEventListener('pointerdown', unlock, true);
  }, [wanted]);

  useEffect(() => {
    const previous = previousStatus.current;
    previousStatus.current = currentStatus;
    if (!usable || !settings.cues || !isRunning) return;
    const cue = cueForStatusChange(previous, currentStatus);
    if (cue) soundEngine.playCue(cue, settings.volume);
  }, [currentStatus, isRunning, usable, settings.cues, settings.volume]);

  const playMusic =
    usable &&
    shouldPlayBreakMusic({ enabled: settings.music, isRunning, role: currentSpeaker?.role, status: currentStatus });

  useEffect(() => {
    if (playMusic) soundEngine.startMusic(settings.track, settings.volume);
    else soundEngine.stopMusic();
    // Volume follows below without restarting the track.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playMusic, settings.track]);

  useEffect(() => {
    soundEngine.setMusicVolume(settings.volume);
  }, [settings.volume]);

  useEffect(() => () => soundEngine.stopMusic(), []);

  return null;
}
