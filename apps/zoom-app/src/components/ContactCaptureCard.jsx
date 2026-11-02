import { Mail, X } from 'lucide-react';

/**
 * The in-app offer of the approval a user skipped on Zoom's own screen.
 * Shown by ContactCapture, never on its own.
 *
 * A card, not a modal: it sits over the bottom of the app without blocking
 * the timer, and ContactCapture takes it down the moment a speech starts.
 * The copy says plainly that approving leads to email, so the consent matches
 * what the privacy policy describes.
 */
export default function ContactCaptureCard({ onApprove, onDismiss, busy = false }) {
  return (
    <div className="fixed bottom-4 inset-x-4 z-40 mx-auto max-w-md">
      <section
        role="region"
        aria-labelledby="contact-capture-title"
        className="bg-white rounded-lg shadow-lg border border-gray-200 p-4"
      >
        <div className="flex justify-between items-start gap-3 mb-2">
          <h3 id="contact-capture-title" className="text-base font-semibold flex items-center gap-2">
            <Mail className="w-4 h-4 text-blue-500 flex-shrink-0" aria-hidden />
            Stay in touch with Toastmusters Timer
          </h3>
          <button
            onClick={onDismiss}
            disabled={busy}
            className="text-gray-400 hover:text-gray-600 flex-shrink-0 disabled:opacity-50"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <p className="text-sm text-gray-600 mb-4">
          Approve the app in Zoom so we can email you important updates: new features, changes and
          the occasional request for feedback. You can opt out of these emails at any time.
        </p>

        <div className="flex gap-2 justify-end">
          <button
            onClick={onDismiss}
            disabled={busy}
            className="px-4 py-2 bg-gray-300 hover:bg-gray-400 text-gray-800 font-semibold rounded-lg transition-colors text-sm disabled:opacity-50"
          >
            Not now
          </button>
          <button
            onClick={onApprove}
            disabled={busy}
            className="px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white font-semibold rounded-lg transition-colors text-sm disabled:opacity-50"
          >
            Approve in Zoom
          </button>
        </div>
      </section>
    </div>
  );
}
