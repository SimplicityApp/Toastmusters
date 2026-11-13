import { useEffect, useRef, useState, lazy, Suspense } from 'react';
import { useEntitlement } from '../hooks/useEntitlement';
import { useFlag } from '../hooks/useFlag';
import { X, Plus, Check, Trash2, Share2 } from 'lucide-react';
import {
  CARD_COLORS,
  CLUB_CARD_SET_ID,
  DEFAULT_CARD_SETS,
  getCardImageSettings,
  activeCardSetId,
  clubCardSetAvailable,
  getClubCardImage,
  selectCardSet,
  addCustomCardSet,
  deleteCustomCardSet,
  getCustomCardImage,
  fileToCardBlob,
  initCardImages,
  canPublishCards,
  publishCardSet,
  loadClubCards,
  subscribeCardImages,
} from '@toastmaster-timer/shared';
import { getCardFileUrl, notifyCardImagesChanged, preloadBackgroundImages } from '../utils/zoomSdk';
import { getSessionToken } from '../utils/zoomIdentity';
import { useClub } from '../hooks/useClub';
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

const SHARE_ERRORS = {
  forbidden: 'Only your club’s admins and editors can share cards with the club.',
  upgrade_required: 'Your club’s Pro has ended, so it can’t take new cards.',
  storage_limit: 'Your club’s card storage is full.',
  image_too_large: 'One of these images is too large to share.',
  network: 'Could not reach the server. Check your connection and try again.',
};

/**
 * One selectable set: a labeled row of the four cards. The row itself is the
 * radio; a custom set also carries a delete button, which must not double as
 * a click on the row.
 */
function CardSetRow({ label, selected, onSelect, thumbSrc, onDelete, onShare, sharing }) {
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
        <span className="flex items-center gap-1">
          {onShare && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onShare();
              }}
              disabled={sharing}
              className="flex items-center gap-1 px-1.5 py-1 rounded text-xs text-blue-600 hover:bg-blue-50 disabled:opacity-50 transition-colors"
              aria-label={`Share the ${label} card set with my club`}
            >
              <Share2 className="h-3.5 w-3.5" />
              {sharing ? 'Sharing…' : 'Share with my club'}
            </button>
          )}
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
        </span>
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
  // The Upgrade link opens the purchase, which stays dark until pro is
  // released. Until then the note reads as it does while the plan is unknown.
  const { enabled: proEnabled, known: flagsKnown } = useFlag('pro');
  const [showUpgrade, setShowUpgrade] = useState(false);
  const [settings, setSettings] = useState(() => getCardImageSettings());
  // The club's set is not in the metadata, so which set shows is asked of the
  // shared module rather than read off `settings`.
  const [activeSetId, setActiveSetId] = useState(() => activeCardSetId());
  const { club, clubName } = useClub();
  // The kit carries the name when there is one; the club record always does.
  const clubLabel = clubName || club?.club?.name || null;
  const [sharingSetId, setSharingSetId] = useState(null);
  // Re-render when the club's images arrive, so its thumbnails fill in.
  const [, setClubGeneration] = useState(0);
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
      if (!cancelled) {
        setSettings(getCardImageSettings());
        setActiveSetId(activeCardSetId());
      }
    });
    const unsubscribe = subscribeCardImages(() => {
      setActiveSetId(activeCardSetId());
      setClubGeneration((generation) => generation + 1);
    });
    return () => {
      cancelled = true;
      unsubscribe();
      Object.values(draftRef.current).forEach((entry) => URL.revokeObjectURL(entry.url));
    };
  }, []);

  if (!isOpen) return null;

  const changed = () => {
    setSettings(getCardImageSettings());
    setActiveSetId(activeCardSetId());
    notifyCardImagesChanged();
    onImagesChanged?.();
    // The notify above dropped every decoded overlay frame; re-decode the new
    // set's four cards now, off the critical path, so the coming status
    // switches (blue -> green -> yellow -> red) push straight from cache.
    preloadBackgroundImages();
  };

  const handleSelect = (setId) => {
    if (setId === activeSetId) return;
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

  // No label: "Custom 1" is this device's slot name, and every other club device
  // has its own "Custom 1". Unlabelled, the set reads "<club> cards" everywhere.
  const handleShare = async (setId) => {
    setSharingSetId(setId);
    const result = await publishCardSet(setId, { getToken: getSessionToken });
    setSharingSetId(null);
    if (result.ok) {
      showToast(`Shared with ${clubLabel || 'your club'}. Every club device gets these cards.`, 'success');
    } else {
      showToast(SHARE_ERRORS[result.error] || 'Could not share these cards. Try again.', 'error');
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
          {clubCardSetAvailable() && (
            <CardSetRow
              key={CLUB_CARD_SET_ID}
              label={loadClubCards()?.label || `${clubLabel || 'Club'} cards`}
              selected={activeSetId === CLUB_CARD_SET_ID}
              onSelect={() => handleSelect(CLUB_CARD_SET_ID)}
              thumbSrc={(color) => getClubCardImage(color) || getCardFileUrl(CLASSIC_FILES[color])}
            />
          )}

          {DEFAULT_CARD_SETS.map((set) => (
            <CardSetRow
              key={set.id}
              label={set.label}
              selected={activeSetId === set.id}
              onSelect={() => handleSelect(set.id)}
              thumbSrc={(color) => getCardFileUrl(set.files[color])}
            />
          ))}

          {settings.customSets.map((set, index) => (
            <CardSetRow
              key={set.id}
              label={`Custom ${index + 1}`}
              selected={activeSetId === set.id}
              onSelect={() => handleSelect(set.id)}
              // A color the set has no upload for shows — and times with —
              // the Classic card.
              thumbSrc={(color) => getCustomCardImage(set.id, color) || getCardFileUrl(CLASSIC_FILES[color])}
              onDelete={() => handleDelete(set.id)}
              onShare={club && canPublishCards() ? () => handleShare(set.id) : undefined}
              sharing={sharingSetId === set.id}
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
          {club?.entitled ? (
            <>
              Custom images are stored only in this browser.
              {canPublishCards() ? ' Share a set to put it on every club device. ' : ' '}
            </>
          ) : isPro ? (
            <>Custom images are backed up and follow you to your other devices. </>
          ) : known && flagsKnown && proEnabled ? (
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
