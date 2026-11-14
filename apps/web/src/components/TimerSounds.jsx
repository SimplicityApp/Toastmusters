import { useEffect, useRef } from 'react'
import { cueForStatusChange } from '@toastmaster-timer/shared'
import { useTimerTick } from '../context/TimerContext'
import { soundEngine, useSoundSettings, useSoundsAccess } from '../hooks/useSounds'

/**
 * Plays the card-change chime. Renders nothing.
 *
 * Mounted above the panel rather than in the Live tab: the timer usually runs
 * with the panel minimized, which unmounts the tabs.
 */
export default function TimerSounds() {
  const { currentStatus, isRunning } = useTimerTick()
  const settings = useSoundSettings()
  const { usable } = useSoundsAccess()
  const previousStatus = useRef(currentStatus)
  const wanted = usable && settings.cues

  // Browsers only let audio start after a click. Start is one, but create the
  // context on any click so the first chime is not the one that gets eaten.
  useEffect(() => {
    if (!wanted) return undefined
    const unlock = () => soundEngine.unlock()
    document.addEventListener('pointerdown', unlock, true)
    return () => document.removeEventListener('pointerdown', unlock, true)
  }, [wanted])

  useEffect(() => {
    const previous = previousStatus.current
    previousStatus.current = currentStatus
    if (!wanted || !isRunning) return
    const cue = cueForStatusChange(previous, currentStatus)
    if (cue) soundEngine.playCue(cue, settings.volume)
  }, [currentStatus, isRunning, wanted, settings.volume])

  return null
}
