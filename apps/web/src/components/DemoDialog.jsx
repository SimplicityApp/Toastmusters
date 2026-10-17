import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import YouTubePlayer from './YouTubePlayer'

/**
 * The full product demo, in a popup.
 *
 * Nothing of YouTube exists on the page until this opens: the player (its
 * script, about 4 MB, and its cookie) mounts with the dialog, so a visit that
 * never presses Watch never touches YouTube. The press is also the gesture
 * that lets the video start on its own.
 *
 * Same manners as the screenshot lightbox: Escape, the backdrop and the button
 * all close it, and body scroll is frozen while it is up. On top of that, focus
 * moves in on open, Tab stays inside, and focus returns to what opened it.
 *
 * `children` are the actions in the footer (the page's own Add to Zoom button),
 * so the dialog needs no knowledge of install URLs or tracking.
 */
export default function DemoDialog({ open, onClose, videoId, title, meta, page, children }) {
  const panel = useRef(null)
  const closeButton = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    const opener = document.activeElement
    closeButton.current?.focus()
    const onKey = (e) => {
      if (e.key === 'Escape') { onClose(); return }
      if (e.key !== 'Tab' || !panel.current) return
      const stops = [...panel.current.querySelectorAll('button, a[href], iframe')]
      if (stops.length === 0) return
      const first = stops[0]
      const last = stops[stops.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey)
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previousOverflow
      if (opener?.isConnected) opener.focus?.()
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-start sm:items-center justify-center overflow-y-auto bg-ink/75 backdrop-blur-sm p-4"
    >
      {/* The close button sits above the card on a phone, so it never covers
          the player's own controls in its top corner. */}
      <div
        ref={panel}
        onClick={(e) => e.stopPropagation()}
        className="relative mt-14 sm:mt-0 w-full max-w-[920px] rounded-[20px] bg-white p-3 pb-4 sm:p-3.5 sm:pb-[18px] shadow-[0_30px_80px_rgba(0,0,0,0.5)]"
      >
        <button
          ref={closeButton}
          type="button"
          onClick={onClose}
          aria-label="Close the demo"
          className="absolute -top-12 right-0 sm:-top-3.5 sm:-right-3.5 z-10 flex h-11 w-11 items-center justify-center rounded-full bg-white text-ink shadow-[0_6px_18px_rgba(0,0,0,0.35)] hover:bg-stone-100 transition-colors"
        >
          <X className="h-[18px] w-[18px]" strokeWidth={2.4} aria-hidden />
        </button>
        <div className="overflow-hidden rounded-xl bg-ink">
          <YouTubePlayer videoId={videoId} title={title} page={page} autoplay />
        </div>
        <div className="mt-4 flex flex-col gap-3 px-1.5 sm:flex-row sm:items-center sm:gap-3.5">
          <div className="flex-1">
            <h2 className="font-display text-lg font-extrabold text-ink">{title}</h2>
            {meta && <p className="mt-0.5 text-sm text-stone-500">{meta}</p>}
          </div>
          {children}
        </div>
      </div>
    </div>
  )
}
