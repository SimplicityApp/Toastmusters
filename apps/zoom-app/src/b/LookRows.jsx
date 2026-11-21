import { ChevronRight, Image, Layers, Video, Volume2 } from 'lucide-react';

const ROW =
  'flex w-full items-center gap-2.5 rounded-[10px] border border-gray-200 bg-white px-3 py-2.5 text-left text-sm text-gray-900 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-blue-500';

/** Design B's names for the three display modes. */
export const VIDEO_MODE_NOTES = Object.freeze({
  camera: 'Camera + timer',
  card: 'Timer only',
  stage: 'Full-screen timer',
});

/**
 * "Look & sound" (the BLook board): one wide row per setting, each showing
 * what it is set to now and opening only its own sheet.
 *
 * @param {{
 *   video: string,
 *   cards: string,
 *   sounds: string,
 *   soundsLocked: boolean,
 *   between: string,
 *   onOpen: (sheet: 'video'|'cards'|'sounds'|'between') => void,
 * }} props
 */
export default function LookRows({ video, cards, sounds, soundsLocked, between, onOpen }) {
  const rows = [
    { id: 'video', label: 'On your video', note: video, Icon: Video },
    { id: 'cards', label: 'Cards', note: cards, Icon: Image },
    { id: 'sounds', label: 'Sounds', note: soundsLocked ? null : sounds, Icon: Volume2, pro: soundsLocked },
    { id: 'between', label: 'Between speeches', note: between, Icon: Layers },
  ];

  return (
    <section aria-labelledby="look-and-sound">
      <h2 id="look-and-sound" className="mx-0.5 mb-2 mt-0 text-xs font-normal text-slate-500">
        Look &amp; sound
      </h2>
      <div className="flex flex-col gap-1.5">
        {rows.map(({ id, label, note, Icon, pro }) => (
          <button
            key={id}
            type="button"
            onClick={() => onOpen(id)}
            aria-label={`${label}${pro ? ', Pro' : note ? `: ${note}` : ''}`}
            className={ROW}
          >
            <Icon className="h-[18px] w-[18px] flex-shrink-0 text-slate-600" aria-hidden="true" />
            <span className="flex-1">{label}</span>
            {pro && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-bold text-amber-800">PRO</span>}
            {note && <span className="max-w-[45%] truncate text-[13px] text-slate-500">{note}</span>}
            <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-slate-400" aria-hidden="true" />
          </button>
        ))}
      </div>
    </section>
  );
}
