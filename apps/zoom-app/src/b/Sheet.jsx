import { useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A bottom sheet: design B's one way of opening a setting (plan 13). The panel
 * dims, the sheet rises from the bottom edge with a title and a close button,
 * and only that one setting is inside it.
 *
 * A modal dialog to assistive tech and the keyboard: focus moves in when it
 * opens and goes back to whatever opened it when it closes, Tab stays inside,
 * Escape and a press on the dimmed panel close it.
 *
 * @param {{
 *   open: boolean,
 *   onClose: () => void,
 *   title: string,
 *   description?: import('react').ReactNode,
 *   badge?: import('react').ReactNode,
 *   children: import('react').ReactNode,
 * }} props - `badge` sits beside the title (the PRO tag on Sounds)
 */
export default function Sheet({ open, onClose, title, description, badge, children }) {
  const titleId = useId();
  const sheetRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return undefined;
    const opener = document.activeElement;
    const sheet = sheetRef.current;
    const first = sheet?.querySelector(FOCUSABLE);
    (first || sheet)?.focus();

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !sheet) return;
      const focusable = [...sheet.querySelectorAll(FOCUSABLE)];
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const firstEl = focusable[0];
      const lastEl = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === firstEl) {
        event.preventDefault();
        lastEl.focus();
      } else if (!event.shiftKey && document.activeElement === lastEl) {
        event.preventDefault();
        firstEl.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      {/* The dimmed panel. A press here closes, like the close button; it is
          not a control of its own, so it stays out of the tab order. */}
      <div
        data-testid="sheet-backdrop"
        aria-hidden="true"
        className="absolute inset-0 bg-slate-900/45"
        onClick={() => onCloseRef.current()}
      />
      <section
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="relative flex max-h-[88vh] flex-col rounded-t-[18px] bg-white text-gray-900 shadow-[0_-8px_24px_rgba(0,0,0,0.18)] outline-none"
      >
        <div className="flex justify-center pt-2" aria-hidden="true">
          <span className="h-1 w-10 rounded-full bg-slate-300" />
        </div>
        <div className="flex items-center gap-2 px-4 pt-2 pb-0.5">
          <h2 id={titleId} className="m-0 text-[17px] font-semibold">
            {title}
          </h2>
          {badge}
          <span className="flex-1" />
          <button
            type="button"
            onClick={() => onCloseRef.current()}
            aria-label="Close"
            className="flex h-[30px] w-[30px] items-center justify-center rounded-full bg-slate-100 text-slate-600 hover:bg-slate-200"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
        {description && <p className="mx-4 mb-3 mt-0 text-[13px] text-slate-500">{description}</p>}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">{children}</div>
      </section>
    </div>
  );
}
