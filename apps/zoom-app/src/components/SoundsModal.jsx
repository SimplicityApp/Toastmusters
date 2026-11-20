import { X, Lock } from 'lucide-react';
import { soundEngine, useSoundsAccess } from '../hooks/useSounds';
import SoundsPanel from './SoundsPanel';

/** The Sounds dialog: the Pro sound settings in a window of their own. */
export default function SoundsModal({ isOpen, onClose }) {
  const { lockReason } = useSoundsAccess();

  if (!isOpen) return null;

  const handleClose = () => {
    soundEngine.stopMusic();
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg p-6 w-full max-w-md max-h-full overflow-y-auto">
        <div className="flex justify-between items-center mb-1">
          <h3 className="text-lg font-semibold flex items-center gap-2">
            Sounds
            {lockReason && <Lock className="h-4 w-4 text-gray-400" aria-label="Locked" />}
            <span className="text-[10px] font-semibold uppercase tracking-wide text-blue-700 bg-blue-50 rounded px-1.5 py-0.5">
              Pro
            </span>
          </h3>
          <button onClick={handleClose} className="text-gray-400 hover:text-gray-600" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        <p className="text-sm text-gray-500 mb-4">
          For speakers who can&apos;t watch the card while they speak, and for a livelier break.
        </p>

        <SoundsPanel />
      </div>
    </div>
  );
}
