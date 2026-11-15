import { Check, Info } from 'lucide-react';
import CardSetsPanel from '../components/CardSetsPanel';
import SoundsPanel from '../components/SoundsPanel';
import OwnBackgroundPicker from '../components/OwnBackgroundPicker';
import { soundEngine } from '../hooks/useSounds';
import Sheet from './Sheet';

const CHOICE = 'flex w-full items-center gap-3 rounded-xl px-3 text-left';

/** A 72×42 sketch of what the meeting sees, for the mode and background choices. */
function Sketch({ kind }) {
  const person = (
    <>
      <span className="absolute bottom-0 left-6 h-[26px] w-6 rounded-t-xl bg-slate-800" />
      <span className="absolute left-[30px] top-1.5 h-3 w-3 rounded-full bg-slate-800" />
    </>
  );
  const base = 'relative h-[42px] w-[72px] flex-shrink-0 overflow-hidden rounded-md';
  if (kind === 'camera') return <span aria-hidden="true" className={`${base} bg-[#4f86f7]`}>{person}</span>;
  if (kind === 'card')
    return (
      <span aria-hidden="true" className={`${base} flex items-center justify-center bg-[#4f86f7] font-mono text-xs font-bold text-white`}>
        04:27
      </span>
    );
  if (kind === 'stage')
    return (
      <span aria-hidden="true" className={`${base} flex items-center justify-center border-2 border-[#4f86f7] text-[10px] font-extrabold text-blue-600`}>
        FULL
      </span>
    );
  if (kind === 'card-idle') return <span aria-hidden="true" className={`${base} bg-[#4f86f7]`}>{person}</span>;
  return (
    <span aria-hidden="true" className={`${base} bg-slate-200`}>
      <span className="absolute bottom-0 left-6 h-[26px] w-6 rounded-t-xl bg-slate-500" />
      <span className="absolute left-[30px] top-1.5 h-3 w-3 rounded-full bg-slate-500" />
    </span>
  );
}

function Choice({ selected, onSelect, sketch, title, detail, children }) {
  return (
    <div className={selected ? 'rounded-xl border-2 border-blue-600 bg-blue-50' : 'rounded-xl border border-gray-200 bg-white'}>
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        onClick={onSelect}
        className={`${CHOICE} ${selected ? 'py-2.5' : 'py-[11px] hover:bg-slate-50'} rounded-xl border-0`}
      >
        {sketch && <Sketch kind={sketch} />}
        <span className="min-w-0 flex-1">
          <strong className={`block text-[15px] ${selected ? 'text-blue-900' : 'text-gray-900'}`}>{title}</strong>
          <span className="block text-xs text-slate-600">{detail}</span>
        </span>
        {selected && <Check className="h-[18px] w-[18px] flex-shrink-0 text-blue-600" strokeWidth={2.6} aria-hidden="true" />}
      </button>
      {children}
    </div>
  );
}

const MODES = [
  { mode: 'camera', title: 'Camera + timer', detail: 'The colour sits behind you' },
  { mode: 'card', title: 'Timer only', detail: 'The colour replaces your video' },
  { mode: 'stage', title: 'Full-screen timer', detail: 'A big timer to share or pop out' },
];

/** "On your video" (board B-L01): how the meeting sees the timer. */
export function VideoSheet({ open, onClose, overlayMode, onSelect, onClear, isClearing }) {
  return (
    <Sheet open={open} onClose={onClose} title="On your video" description="How the timer shows to everyone in the meeting.">
      <div role="radiogroup" aria-label="Display mode" className="flex flex-col gap-2">
        {MODES.map(({ mode, title, detail }) => (
          <Choice
            key={mode}
            selected={overlayMode === mode}
            onSelect={() => onSelect(mode)}
            sketch={mode}
            title={title}
            detail={detail}
          />
        ))}
      </div>
      <div className="mt-4 flex items-center gap-2.5 border-t border-slate-100 pt-3">
        <span className="flex-1 text-[13px] text-slate-600">Timer stuck on your video?</span>
        <button
          type="button"
          onClick={onClear}
          disabled={isClearing}
          className="rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-[13px] font-semibold text-gray-900 hover:bg-slate-50 disabled:opacity-50"
        >
          {isClearing ? 'Clearing…' : 'Clear from my video'}
        </button>
      </div>
    </Sheet>
  );
}

/** "Cards" (boards B-L03, L04): the card sets, and nothing else. */
export function CardsSheet({ open, onClose, onImagesChanged }) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Cards"
      description="The card the timer shows at each colour, on the panel and on your video."
    >
      <CardSetsPanel onImagesChanged={onImagesChanged} />
    </Sheet>
  );
}

/** "Sounds" (boards B-L05, L06): the Pro sounds, locked or not. */
export function SoundsSheet({ open, onClose }) {
  const close = () => {
    soundEngine.stopMusic();
    onClose();
  };
  return (
    <Sheet
      open={open}
      onClose={close}
      title="Sounds"
      badge={<span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-bold text-amber-800">PRO</span>}
      description="For speakers who can't watch the card, and for a livelier break."
    >
      <SoundsPanel />
    </Sheet>
  );
}

/**
 * "Between speeches" (board B-L07): what the video shows when no timer runs.
 * Either the blue timer card stays up (today's default), or the video is
 * handed back after every speech, to the organizer's own background when they
 * have saved one.
 */
export function BetweenSheet({ open, onClose, revealFaceWhenIdle, onChoose, onBackgroundChanged }) {
  return (
    <Sheet open={open} onClose={onClose} title="Between speeches" description="What your video shows when no timer is running.">
      <div role="radiogroup" aria-label="Between speeches" className="flex flex-col gap-2">
        <Choice
          selected={!revealFaceWhenIdle}
          onSelect={() => onChoose(false)}
          sketch="card-idle"
          title="Timer card"
          detail="The blue card stays on your video"
        />
        <Choice
          selected={revealFaceWhenIdle}
          onSelect={() => onChoose(true)}
          sketch="video"
          title="My video"
          detail="The timer comes off after each speech"
        >
          {revealFaceWhenIdle && (
            <div className="px-3 pb-3">
              <OwnBackgroundPicker onChange={onBackgroundChanged} />
            </div>
          )}
        </Choice>
      </div>

      <div className="mt-3.5 flex gap-2.5 rounded-xl bg-slate-50 px-3 py-2.5 text-xs leading-relaxed text-slate-600">
        <Info className="mt-px h-4 w-4 flex-shrink-0 text-slate-500" aria-hidden="true" />
        <span>
          {revealFaceWhenIdle
            ? 'After each speech, the timer puts your own background back, or what Zoom had before when you have not saved one. Zoom may ask you to allow the change.'
            : 'Between speeches the blue card stays up, so the meeting always sees the timer.'}
        </span>
      </div>
      <p className="mb-0 mt-3 text-[11px] leading-relaxed text-slate-400">
        Saved in this browser only. Upload only images you have the right to use.
      </p>
    </Sheet>
  );
}
