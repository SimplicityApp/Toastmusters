import { useEffect, useRef, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import {
  fileToCardBlob,
  hasOwnBackground,
  getOwnBackgroundUrl,
  saveOwnBackground,
  clearOwnBackground,
  initCardImages,
} from '@toastmaster-timer/shared';
import { notifyOwnBackgroundChanged, applyOwnBackground, removeOwnBackground } from '../utils/zoomSdk';
import { useToast } from '../context/ToastContext';

/**
 * Pick the background the timer puts back when a speech ends.
 *
 * A section of the Card Images modal rather than a dialog of its own.
 *
 * Why it exists: without one, handing the organizer their background back means
 * asking Zoom what they had and asking for its pixels, across APIs that are not
 * in the shipped SDK typing, that a client may grant none of, and that name a
 * background by an id the pixel call need not accept. Every way that fails ends
 * with the organizer somewhere they did not choose. An image stored here is the
 * answer to "what should I be on", so the restore has nothing left to get wrong.
 */
export default function OwnBackgroundPicker({ onChange }) {
  const [imageUrl, setImageUrl] = useState(null);
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef(null);
  const { showToast } = useToast();

  // The object URL is minted by initCardImages, which may still be running when
  // this mounts — the same reason the card picker waits on it.
  useEffect(() => {
    let alive = true;
    initCardImages().then(() => {
      if (alive) setImageUrl(hasOwnBackground() ? getOwnBackgroundUrl() : null);
    });
    return () => {
      alive = false;
    };
  }, []);

  const refresh = () => {
    setImageUrl(hasOwnBackground() ? getOwnBackgroundUrl() : null);
    // The overlay module caches the decoded pixels; a new upload has to win.
    notifyOwnBackgroundChanged();
    onChange?.();
  };

  const handleUpload = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      // Re-encoded to the same box the timing cards use: 1280x720 is a good
      // virtual background and stays well inside what setVirtualBackground
      // takes, where a phone photo would not.
      const blob = await fileToCardBlob(file);
      if (!(await saveOwnBackground(blob))) {
        showToast('Could not save — browser storage is full. Try a smaller image.', 'error');
        return;
      }
      refresh();
      // Put it on their video straight away: picking a background and seeing
      // nothing happen reads as a setting that did not take, and this is the
      // one moment they are looking at the result.
      const applied = await applyOwnBackground();
      showToast(
        {
          applied: 'Saved — your background is on your video now.',
          // Declined rather than failed: the card on their video outranks a
          // preview of a setting that applies when it comes off anyway.
          busy: 'Saved. Your video returns to this when the timer clears.',
          unavailable: 'Saved. Speeches will end on this background.',
        }[applied],
        'success'
      );
    } catch {
      showToast('That file could not be read as an image.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async () => {
    setBusy(true);
    try {
      // Storage first: if the organizer declines Zoom's removal dialog, the
      // setting is still gone — that is what they asked for, and only their
      // video is left as it was.
      await clearOwnBackground();
      refresh();
      // Off the video too, mirroring the upload. A setting that put an image
      // on their video should take it off again when cleared.
      const removed = await removeOwnBackground();
      showToast(
        {
          removed: 'Removed — your video is back to your camera.',
          declined: 'Removed. Zoom needs your confirmation to take it off your video.',
          busy: 'Removed. Your video changes when the timer clears.',
          unavailable: 'Removed. The timer will put back whatever Zoom reports instead.',
        }[removed],
        removed === 'removed' ? 'success' : 'info'
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-gray-200 p-3">
      <div className="flex items-center justify-between mb-1.5 min-h-[26px]">
        <span className="text-sm font-medium text-gray-900">My background</span>
        {imageUrl && (
          <button
            onClick={handleRemove}
            disabled={busy}
            title="Remove my background"
            aria-label="Remove my background"
            className="text-gray-400 hover:text-red-600 disabled:opacity-50 transition-colors"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </div>

      <div className="flex items-start gap-3">
        {imageUrl ? (
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={busy}
            title="Replace my background"
            aria-label="Replace my background"
            className="w-32 aspect-video rounded overflow-hidden border border-gray-200 flex-shrink-0 disabled:opacity-50"
          >
            <img src={imageUrl} alt="" className="w-full h-full object-cover" />
          </button>
        ) : (
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={busy}
            title="Upload my background"
            aria-label="Upload my background"
            className="w-32 aspect-video rounded border-2 border-dashed border-gray-300 flex items-center justify-center text-gray-400 hover:border-gray-400 hover:text-gray-600 disabled:opacity-50 transition-colors flex-shrink-0"
          >
            <Plus className="h-4 w-4" />
          </button>
        )}

        <p className="text-xs text-gray-500 min-w-0">
          {imageUrl
            ? 'When a speech ends, your video goes back to this — every time, whatever you were on before.'
            : 'Upload the background you want your video to return to when a speech ends. Without one, the timer asks Zoom what you had, which some Zoom clients will not say.'}
        </p>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          handleUpload(e.target.files?.[0]);
          // Same file re-picked later must fire change again.
          e.target.value = '';
        }}
      />
    </div>
  );
}
