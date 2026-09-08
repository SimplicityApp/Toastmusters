import { useEffect, useRef, useState, lazy, Suspense } from 'react';
import { useEntitlement } from '../hooks/useEntitlement';
import { X, Plus, Check, Trash2 } from 'lucide-react';
import {
  CARD_COLORS,
  DEFAULT_CARD_SETS,
  getCardImageSettings,
  selectCardSet,
  addCustomCardSet,
  deleteCustomCardSet,
  getCustomCardImage,
  fileToCardBlob,
  initCardImages,
} from '@toastmaster-timer/shared';
import { getCardFileUrl, notifyCardImagesChanged, preloadBackgroundImages } from '../utils/zoomSdk';
import OwnBackgroundPicker from './OwnBackgroundPicker';
import { useToast } from '../context/ToastContext';
const UpgradeModal = lazy(() => import('./UpgradeModal'));

const COLOR_LABELS = {
  blue: 'Idle (blue)',
  green: 'Green',
  yellow: 'Yellow',
  red: 'Red',
};

// Faint status tint behind each empty upload slot, so the row reads as
// blue/green/yellow/red before any image is picked.
const SLOT_TINTS = {
  blue: '#eff6ff',
  green: '#f0fdf4',
  yellow: '#fefce8',
  red: '#fef2f2',
};

const CLASSIC_FILES = DEFAULT_CARD_SETS[0].files;
const STORAGE_FULL_MESSAGE =
  'Could not save — browser storage is full. Try smaller images or delete another custom set.';

/**
 * One selectable set: a labeled row of the four cards. The row itself is the
 * radio; a custom set also carries a delete button, which must not double as
 * a click on the row.
 */
function CardSetRow({ label, selected, onSelect, thumbSrc, onDelete }) {
  return (
    <div
      role="radio"
      aria-checked={selected}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      className={`rounded-lg border p-2 cursor-pointer transition-colors ${
        selected ? 'border-blue-500 ring-1 ring-blue-500' : 'border-gray-200 hover:border-gray-300'
      }`}
    >
      <div className="flex items-center justify-between mb-1.5">
        <span className="flex items-center gap-1.5 text-sm font-medium text-gray-900">
          {label}
          {selected && <Check className="h-4 w-4 text-blue-600" />}
        </span>
        {onDelete && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className="p-1 rounded text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors"
            aria-label={`Delete the ${label} card set`}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </div>
      <div className="grid grid-cols-4 gap-1.5">
        {CARD_COLORS.map((color) => (
          <img
            key={color}
            src={thumbSrc(color)}
            alt={`${COLOR_LABELS[color]} card`}
            className="w-full aspect-video object-cover rounded border border-gray-200 bg-gray-100"
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Card set picker: the two built-in sets, every custom set the organizer has
 * added, and a row of uploaders for adding another. Custom sets are stored in
 * this browser only, and the built-in sets stay available as the defaults a
 * delete returns to — so the choice of artwork, and the rights to it, sit
 * with the user.
 */
export default function CardImagesModal({ isOpen, onClose, onImagesChanged }) {
  const { showToast } = useToast();
  const { isPro, known } = useEntitlement();
  const [showUpgrade, setShowUpgrade] = useState(false);
  const [settings, setSettings] = useState(() => getCardImageSettings());
  // The set being assembled in the uploader row, color -> {blob, url}. Kept
  // only in this modal until the organizer confirms it into a real set.
  const [draft, setDraft] = useState({});
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const fileInputRef = useRef(null);
  const draftColorRef = useRef(null);

  // The stored Blobs load asynchronously; if the modal opens before they are
  // in, refresh once they are so custom thumbnails fill in. On unmount,
  // release the preview URLs of an unconfirmed draft.
  useEffect(() => {
    let cancelled = false;
    initCardImages().then(() => {
      if (!cancelled) setSettings(getCardImageSettings());
    });
    return () => {
      cancelled = true;
      Object.values(draftRef.current).forEach((entry) => URL.revokeObjectURL(entry.url));
    };
  }, []);

  if (!isOpen) return null;

  const changed = () => {
    setSettings(getCardImageSettings());
    notifyCardImagesChanged();
    onImagesChanged?.();
    // The notify above dropped every decoded overlay frame; re-decode the new
    // set's four cards now, off the critical path, so the coming status
    // switches (blue -> green -> yellow -> red) push straight from cache.
    preloadBackgroundImages();
  };

  const handleSelect = (setId) => {
    if (setId === settings.selectedSetId) return;
    if (selectCardSet(setId)) changed();
    else showToast(STORAGE_FULL_MESSAGE, 'error');
  };

  const handleDraftUpload = async (color, file) => {
    if (!file) return;
    try {
      const blob = await fileToCardBlob(file);
      setDraft((prev) => {
        if (prev[color]) URL.revokeObjectURL(prev[color].url);
        return { ...prev, [color]: { blob, url: URL.createObjectURL(blob) } };
      });
    } catch {
      showToast('That file could not be read as an image.', 'error');
    }
  };

  const handleAddDraft = async () => {
    const images = {};
    for (const color of CARD_COLORS) {
      if (draft[color]) images[color] = draft[color].blob;
    }
    const id = await addCustomCardSet(images);
    if (!id) {
      showToast(STORAGE_FULL_MESSAGE, 'error');
      return;
    }
    Object.values(draft).forEach((entry) => URL.revokeObjectURL(entry.url));
    setDraft({});
    changed();
    showToast('Custom card set added', 'success');
  };

  const handleDelete = async (setId) => {
    if (await deleteCustomCardSet(setId)) {
      changed();
      showToast('Custom card set deleted', 'success');
    }
  };

  const pickDraftFile = (color) => {
    draftColorRef.current = color;
    fileInputRef.current?.click();
  };

  const draftHasImages = CARD_COLORS.some((color) => draft[color]);

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

        <div className="space-y-3" role="radiogroup" aria-label="Card set">
          {DEFAULT_CARD_SETS.map((set) => (
            <CardSetRow
              key={set.id}
              label={set.label}
              selected={settings.selectedSetId === set.id}
              onSelect={() => handleSelect(set.id)}
              thumbSrc={(color) => getCardFileUrl(set.files[color])}
            />
          ))}

          {settings.customSets.map((set, index) => (
            <CardSetRow
              key={set.id}
              label={`Custom ${index + 1}`}
              selected={settings.selectedSetId === set.id}
              onSelect={() => handleSelect(set.id)}
              // A color the set has no upload for shows — and times with —
              // the Classic card.
              thumbSrc={(color) => getCustomCardImage(set.id, color) || getCardFileUrl(CLASSIC_FILES[color])}
              onDelete={() => handleDelete(set.id)}
            />
          ))}

          <div className="rounded-lg border border-dashed border-gray-300 p-2">
            <div className="flex items-center justify-between mb-1.5 min-h-[26px]">
              <span className="text-sm font-medium text-gray-700">Add your own</span>
              {draftHasImages && (
                <button
                  onClick={handleAddDraft}
                  className="px-2.5 py-1 rounded-md bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 transition-colors"
                >
                  Add set
                </button>
              )}
            </div>
            <div className="grid grid-cols-4 gap-1.5">
              {CARD_COLORS.map((color) =>
                draft[color] ? (
                  <button
                    key={color}
                    onClick={() => pickDraftFile(color)}
                    title={`Replace the ${COLOR_LABELS[color]} image`}
                    aria-label={`Replace the ${COLOR_LABELS[color]} image`}
                    className="w-full aspect-video rounded overflow-hidden border border-gray-200"
                  >
                    <img src={draft[color].url} alt="" className="w-full h-full object-cover" />
                  </button>
                ) : (
                  <button
                    key={color}
                    onClick={() => pickDraftFile(color)}
                    title={`Upload the ${COLOR_LABELS[color]} image`}
                    aria-label={`Upload the ${COLOR_LABELS[color]} image`}
                    style={{ backgroundColor: SLOT_TINTS[color] }}
                    className="w-full aspect-video rounded border-2 border-dashed border-gray-300 flex items-center justify-center text-gray-400 hover:border-gray-400 hover:text-gray-600 transition-colors"
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                )
              )}
            </div>
            <p className="text-xs text-gray-500 mt-1.5">
              Upload an image for each color, then Add set. Colors you skip use the Classic card.
            </p>
          </div>
        </div>

        {/* Not a card, but the other image the organizer's video shows — and
            the one they have to go looking for otherwise. */}
        <div className="mt-5 pt-4 border-t border-gray-200">
          <OwnBackgroundPicker />
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            handleDraftUpload(draftColorRef.current, e.target.files?.[0]);
            // Same file re-picked later must fire change again.
            e.target.value = '';
          }}
        />

        <p className="text-xs text-gray-500 mt-4">
          {isPro ? (
            <>Custom images are backed up and follow you to your other devices. </>
          ) : known ? (
            <>
              Custom images are stored only in this browser.{' '}
              <button
                type="button"
                onClick={() => setShowUpgrade(true)}
                className="text-blue-600 hover:text-blue-700 underline"
              >
                Upgrade to Pro
              </button>{' '}
              to back them up and use them on your other devices.{' '}
            </>
          ) : (
            <>Custom images are stored only in this browser. </>
          )}
          Please upload only images you have the right to use — for example your club&apos;s own
          materials. This app is independent and cannot grant permission for third-party logos or
          artwork.
        </p>
        {showUpgrade && (
          <Suspense fallback={null}>
            <UpgradeModal isOpen={showUpgrade} onClose={() => setShowUpgrade(false)} source="card_images" />
          </Suspense>
        )}
      </div>
    </div>
  );
}
