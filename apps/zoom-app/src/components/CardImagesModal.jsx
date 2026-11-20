import { X } from 'lucide-react';
import OwnBackgroundPicker from './OwnBackgroundPicker';
import CardSetsPanel from './CardSetsPanel';

/**
 * The Card Images dialog: the card set picker, and the organizer's own
 * background, which is the other image their video shows.
 */
export default function CardImagesModal({ isOpen, onClose, onImagesChanged }) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg p-6 w-full max-w-md max-h-full overflow-y-auto">
        <div className="flex justify-between items-center mb-1">
          <h3 className="text-lg font-semibold">Card Images</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        <p className="text-sm text-gray-500 mb-4">
          Pick the timing cards the timer shows, or upload your own. They show wherever the card
          does — including on your video.
        </p>

        <CardSetsPanel onImagesChanged={onImagesChanged}>
          {/* Not a card, but the other image the organizer's video shows — and
              the one they have to go looking for otherwise. */}
          <div className="mt-5 pt-4 border-t border-gray-200">
            <OwnBackgroundPicker />
          </div>
        </CardSetsPanel>
      </div>
    </div>
  );
}
