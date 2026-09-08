import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import {
  X,
  Timer,
  ClipboardList,
  ClipboardPaste,
  Monitor,
  Video,
  Camera,
} from 'lucide-react'
import { trackEvent } from '../utils/posthog'
import { TOOLS } from '@toastmaster-timer/shared'
import YouTubePlayer from '../components/YouTubePlayer'
import AccountMenu from '../components/AccountMenu'

const ZOOM_APP_URL = 'https://marketplace.zoom.us/zoomapp/DsFHK5sNQs2_VFyeQky2sg/context/meeting/target/launch/deeplink'

/**
 * A tutorial screenshot.
 *
 * Until the file is dropped into apps/web/public/zoom/tutorial/, the image fails
 * to load and this falls back to a labelled box naming the file it wants. That
 * way the page never shows a broken image icon, and adding a screenshot is just
 * copying a file into place with no code change.
 */
function Shot({ src, alt, hint, onZoom }) {
  const [missing, setMissing] = useState(false)

  if (missing) {
    return (
      <div className="w-full aspect-video rounded-xl border-2 border-dashed border-stone-300 bg-stone-50 flex flex-col items-center justify-center text-center px-4 py-6">
        <span className="text-sm font-medium text-stone-600">Screenshot coming soon</span>
        <span className="mt-1 text-xs text-stone-500">{hint}</span>
        <code className="mt-2 text-[11px] text-stone-400 break-all">{src}</code>
      </div>
    )
  }

  // A button, not an img with a click handler: these shots carry the detail the
  // text is describing, and at half the page width that detail is too small to
  // read. Enlarging has to be reachable by keyboard for the same reason it is
  // worth offering at all.
  return (
    <button
      type="button"
      onClick={() => onZoom({ src, alt })}
      className="group relative block w-full cursor-zoom-in rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-ink"
      aria-label={`Enlarge screenshot: ${alt}`}
    >
      <img
        src={src}
        alt={alt}
        loading="lazy"
        onError={() => setMissing(true)}
        // Same box as the placeholder, so nothing shifts when a screenshot lands
        // and a shot that is not quite 16:9 is letterboxed rather than cropped.
        className="w-full aspect-video object-contain rounded-xl border border-stone-200 bg-white shadow-sm transition-transform duration-200 group-hover:scale-[1.02]"
      />
    </button>
  )
}

/**
 * The enlarged screenshot.
 *
 * Closes on Escape, on the backdrop and on the button, because someone who
 * opened this by accident should not have to hunt for the way out. Body scroll
 * is frozen while it is open so dismissing it returns them to the same place on
 * the page they left.
 */
function Lightbox({ shot, onClose }) {
  useEffect(() => {
    if (!shot) return undefined
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previousOverflow
    }
  }, [shot, onClose])

  if (!shot) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={shot.alt}
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-sm p-4 cursor-zoom-out"
    >
      <button
        type="button"
        onClick={onClose}
        className="absolute top-4 right-4 rounded-lg bg-white/10 hover:bg-white/20 p-2 text-white transition-colors"
        aria-label="Close"
      >
        <X className="h-5 w-5" />
      </button>
      {/* Stops a click on the picture itself from closing what it just opened. */}
      <img
        src={shot.src}
        alt={shot.alt}
        onClick={(e) => e.stopPropagation()}
        className="max-h-full max-w-full object-contain rounded-lg shadow-2xl cursor-default"
      />
    </div>
  )
}

// Screenshots to capture in the Zoom app, one per step.
const TUTORIAL_STEPS = [
  {
    title: 'Open the app in your meeting',
    body: 'Add the app to Zoom once. After that it sits in the Apps panel of every meeting, so you can open it as soon as you join.',
    src: '/zoom/tutorial/01-open-in-meeting.jpg',
    hint: 'Zoom meeting with the Apps panel open and the timer showing',
  },
  {
    title: 'Load your agenda',
    body: 'Paste your list of speakers, or paste the meeting page straight from EasySpeak. Every speaker comes in with the right role and time limits, and you can drag them into order.',
    src: '/zoom/tutorial/02-agenda-import.jpg',
    hint: 'Agenda tab with the import box and a filled agenda',
  },
  {
    title: 'Pick how the timer shows up',
    body: 'Open the mode menu at the top of the Live tab. It names the mode you are in, and holds the three above. You can switch at any point, even in the middle of a meeting.',
    src: '/zoom/tutorial/03-mode-menu.jpg',
    hint: 'Live tab with the display mode menu open, showing all three modes',
  },
  {
    title: 'Name the speaker',
    body: 'Pick whoever is up next from your agenda, or straight from the people in the meeting. Someone who is not on the list? Type their name and press Enter to add them. Type over a name and press Enter to fix a spelling, and they keep their place in the running order.',
    src: '/zoom/tutorial/04-speaker-name.jpg',
    hint: 'Speaker name field with the suggestion list open, showing agenda names and people in the meeting',
  },
  {
    title: 'Run the timer',
    body: 'Press START when the speaker begins. Green, yellow and red come up on their own at your club times. Press FINISH to save the time and load the next speaker.',
    src: '/zoom/tutorial/05-live-controls.jpg',
    hint: 'Live tab mid speech, timer running with the green signal up',
  },
  {
    title: 'Share the report',
    body: 'The Report tab lists every speaker with their time and whether they were inside the limits. One click copies it, ready to paste into the meeting chat.',
    src: '/zoom/tutorial/06-report.jpg',
    hint: 'Report tab with a few finished speeches and the copy button',
  },
]

// The three display modes. This is the part clubs ask about most, so each one
// gets its own picture and a plain line about who it suits.
const DISPLAY_MODES = [
  {
    name: 'Timer Stage',
    body: 'The timer fills the whole app panel in full color. Your camera is left alone. From the stage you can share it to the meeting so everyone sees the same signal, or pop it out into its own window and park it on a second screen.',
    bestFor: 'Best for clubs who want one timer everybody can see.',
    src: '/zoom/tutorial/mode-stage.jpg',
    hint: 'Timer Stage open in green, with the share and pop out buttons visible',
  },
  {
    name: 'Timer Card',
    body: 'Your video tile turns into the color card. Your camera stays on but the picture is replaced, so your tile becomes one big green, yellow or red signal in the gallery.',
    bestFor: 'Best for the classic look, where speakers watch the timer’s tile.',
    src: '/zoom/tutorial/mode-card.jpg',
    hint: 'Zoom gallery view with the timer tile showing a yellow card',
  },
  {
    name: 'Timer + Camera',
    body: 'The color sits behind you as a virtual background. Speakers see your face and the color at the same time.',
    bestFor: 'Best for timers who also want to be seen, for nods and hand signals.',
    src: '/zoom/tutorial/mode-camera.jpg',
    hint: 'Timer on camera with a red background behind their face',
  },
]

// Small options that are easy to miss but change how a meeting feels.
const TIPS = [
  {
    title: 'Hide the countdown',
    body: 'On the Timer Stage, the eye icon hides the clock. Speakers then read only the color, the way they would read timing cards in the room. You still see the numbers and the controls.',
    src: '/zoom/tutorial/tip-hide-clock.jpg',
    hint: 'Timer Stage with the clock hidden, eye icon highlighted',
  },
  {
    title: 'Show my own background between speeches',
    body: 'In the two video modes, your normal camera comes back the moment a speech ends and the color returns when the next one starts. Zoom asks you to confirm each switch. Turn it off if you would rather keep the color up all meeting.',
    src: '/zoom/tutorial/tip-reveal-face.jpg',
    hint: 'Mode menu with the "Show my own background" checkbox',
  },
  {
    title: 'Clear the timer from your video',
    body: 'Clear Background takes the timer off your video and puts your camera back the way it was. RESET does the same on its way to zeroing the clock, so this is the one to reach for when you hand the role to someone else, or if anything looks stuck.',
    src: '/zoom/tutorial/tip-clear-video.jpg',
    hint: 'Live tab with the Clear Background button',
  },
]

// Clubs we know are running their meetings with the timer, from the in-app club
// survey and direct conversations. Add a club here as soon as it confirms —
// name it exactly the way the club names itself.
const TRUSTED_CLUBS = [
  { name: 'Jacaranda Chinese English Toastmasters', place: 'District 129' },
  { name: 'Women LEAD Toastmasters', place: 'District 101' },
  { name: 'Sapphire City Toastmasters', place: 'District 70' },
  { name: 'Malabar Toastmasters', place: 'Calicut, India' },
  // Placeholders — swap in real clubs as they confirm.
  { name: 'Your Club Here', place: 'Anywhere in the world', placeholder: true },
]

// The feature grid. Each card is one thing the timer does, said once; the
// bodies are the same claims the old bullet list made, just under a heading
// that can be scanned without reading the sentence.
const FEATURES = [
  {
    icon: Timer,
    dot: 'bg-timer-green',
    title: 'Every speech type, pre-loaded',
    body: 'Timing rules for Standard Speeches, Short Roles, Table Topics, evaluations and more — green, yellow and red at the right minute without any setup.',
  },
  {
    icon: ClipboardList,
    dot: 'bg-timer-yellow',
    title: 'Agenda and reports',
    body: 'Track every speaker through the meeting, then hand the whole timing report to the club in one click.',
  },
  {
    icon: ClipboardPaste,
    dot: 'bg-timer-red',
    title: 'Quick import',
    body: 'Paste your meeting roles — or the whole EasySpeak page — and the agenda loads itself, roles and time limits included.',
  },
  {
    icon: Monitor,
    dot: 'bg-timer-green',
    title: 'Full-color signals in the browser',
    body: 'The page background turns green, yellow and red as time runs, so a shared screen becomes the timing light.',
  },
  {
    icon: Video,
    dot: 'bg-timer-yellow',
    title: 'Three display modes in Zoom',
    body: 'A full-size timer you can share to the whole meeting, a color card in your video tile, or the color behind you on camera.',
  },
  {
    icon: Camera,
    dot: 'bg-timer-red',
    title: 'Automatic virtual backgrounds',
    body: 'In Zoom the background changes on its own at each signal, and your own camera comes back between speeches.',
  },
]

// The sticky header's anchors, in page order. Short labels on purpose — they
// sit in one row and share it with the CTA.
const NAV_LINKS = [
  { href: '#features', label: 'Features' },
  { href: '#display-modes', label: 'Zoom Modes' },
  { href: '#how-to-zoom', label: 'Tutorial' },
  { href: '#demos', label: 'Demos' },
  { href: '#timer-role', label: 'Timer Role' },
]

// The strip's numbers when /api/stats is unreachable (local dev, ad blockers,
// a Worker hiccup). True as of 2026-08-31 — stale-low is fine because the
// display rounds down anyway.
const FALLBACK_STATS = {
  timerUsers: 520,
  countries: 55,
  speechesTimed: 1405,
  appSeconds: 416804,
}

/**
 * Live usage numbers from /api/stats (the Worker's edge-cached PostHog query,
 * refreshed every five minutes). Starts on the baked fallback and swaps in the
 * live values when they arrive, so the strip renders instantly and never shows
 * a loading state.
 */
function useUsageStats() {
  const [stats, setStats] = useState(FALLBACK_STATS)

  useEffect(() => {
    let cancelled = false
    try {
      fetch('/api/stats')
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (cancelled || !data) return
          const { timerUsers, countries, speechesTimed, appSeconds } = data
          if ([timerUsers, countries, speechesTimed, appSeconds].every((n) => typeof n === 'number' && n > 0)) {
            setStats({ timerUsers, countries, speechesTimed, appSeconds })
          }
        })
        .catch(() => {})
    } catch {
      // fetch itself can throw (no network stack in some test environments);
      // the fallback numbers are already on screen.
    }
    return () => { cancelled = true }
  }, [])

  return stats
}

// "520" reads as a live counter about to be wrong; "500+" reads as a floor
// that stays true between cache refreshes. Countries stay exact — rounding
// "55 countries" down would just make it smaller for no honesty gain.
function floorTo(n, step) {
  const floored = Math.floor(n / step) * step
  return floored < step ? `${n}` : `${floored.toLocaleString('en-US')}+`
}

/**
 * The hero's proof line: live usage numbers where a static badge used to be.
 * Real adoption is a stronger opener than promises about pricing, and it can
 * never go stale the way "free forever" would.
 */
function HeroStats() {
  const stats = useUsageStats()
  const hours = Math.floor(stats.appSeconds / 3600)
  const items = [
    { value: floorTo(stats.timerUsers, 50), label: 'Toastmasters', dot: 'bg-timer-green' },
    { value: `${stats.countries}`, label: 'countries', dot: 'bg-timer-yellow' },
    { value: floorTo(stats.speechesTimed, 100), label: 'speeches timed', dot: 'bg-timer-red' },
    { value: floorTo(hours, 10), label: 'hours using the app', dot: 'bg-timer-green' },
  ]

  return (
    <dl className="flex flex-wrap items-center justify-center gap-2">
      {items.map((item) => (
        <div
          key={item.label}
          className="flex items-baseline gap-1.5 rounded-full border border-stone-200 bg-white px-4 py-1.5 shadow-sm"
        >
          <span className={`self-center h-2 w-2 rounded-full ${item.dot}`} aria-hidden />
          <dd className="font-display text-sm font-bold text-ink">{item.value}</dd>
          <dt className="text-sm text-stone-500">{item.label}</dt>
        </div>
      ))}
    </dl>
  )
}

/**
 * The rolling "Trusted by" strip.
 *
 * The track renders the club list twice and slides one copy's width before
 * restarting, which reads as an endless loop. The second copy is decoration, so
 * it is hidden from screen readers; they get the list once, in order. Hovering
 * pauses the roll, and prefers-reduced-motion stops it entirely (the CSS side
 * of this lives in index.css next to the keyframes).
 */
function TrustedBy() {
  const chips = (hidden) => (
    <ul
      aria-hidden={hidden || undefined}
      className="flex items-center gap-4 pr-4 flex-shrink-0"
    >
      {TRUSTED_CLUBS.map((club) => (
        <li
          key={club.name}
          className={`flex flex-col items-center whitespace-nowrap rounded-full border px-6 py-2.5 ${
            club.placeholder
              ? 'border-dashed border-stone-300 bg-transparent'
              : 'border-stone-200 bg-white shadow-sm'
          }`}
        >
          <span className={`text-sm font-medium ${club.placeholder ? 'text-stone-400' : 'text-ink'}`}>
            {club.name}
          </span>
          <span className="text-xs text-stone-500">{club.place}</span>
        </li>
      ))}
    </ul>
  )

  return (
    <section aria-label="Clubs using Toastmasters Timer" className="py-14">
      <h2 className="text-center font-display text-2xl sm:text-3xl font-extrabold tracking-tight mb-8">
        Trusted by Toastmasters clubs worldwide
      </h2>
      <div className="overflow-hidden" style={{ maskImage: 'linear-gradient(90deg, transparent, black 8%, black 92%, transparent)', WebkitMaskImage: 'linear-gradient(90deg, transparent, black 8%, black 92%, transparent)' }}>
        {/* Four copies, not two: the loop slides half the track, so the half
            must be wider than any viewport or a blank gap rolls through. Two
            copies of a short club list only cover ~1250px. */}
        <div className="flex w-max animate-marquee">
          {chips(false)}
          {chips(true)}
          {chips(true)}
          {chips(true)}
        </div>
      </div>
    </section>
  )
}

/**
 * John's portrait, with the same graceful fallback the tutorial screenshots
 * use: until the photo lands in apps/web/public/people/, show his initials
 * instead of a broken image, so shipping the section never waits on the file.
 */
function AmbassadorPhoto() {
  const [missing, setMissing] = useState(false)

  if (missing) {
    return (
      <div
        aria-hidden
        className="h-16 w-16 rounded-full bg-ink flex items-center justify-center flex-shrink-0"
      >
        <span className="text-xl font-semibold text-white">JC</span>
      </div>
    )
  }

  return (
    <img
      src="/people/john-christensen.jpg"
      alt="John C."
      loading="lazy"
      onError={() => setMissing(true)}
      // Anchored to the photo's bottom: it's a portrait selfie with open sky in
      // the top half, so a centered crop shows sky where the face should be.
      className="h-16 w-16 rounded-full object-cover object-bottom ring-2 ring-stone-200 flex-shrink-0"
    />
  )
}

/**
 * The hero's product visual: a mock of the Timer Stage running a Standard
 * Speech, cycling green → yellow → red on a CSS loop. A drawing instead of a
 * screenshot on purpose — it never goes stale, it animates, and the three
 * floating chips can label the signals the way the app's own UI does.
 */
function HeroTimerMock() {
  return (
    <div className="relative mx-auto mt-16 max-w-2xl" aria-hidden>
      {/* The signal chips, floating like timing cards laid on a table. */}
      <div className="hidden sm:flex absolute -left-24 top-8 -rotate-6 items-center gap-2 rounded-full border border-stone-200 bg-white px-4 py-2 shadow-lg z-10">
        <span className="h-3 w-3 rounded-full bg-timer-green" />
        <span className="text-sm font-semibold text-ink">Green</span>
        <span className="text-sm text-stone-500 tabular-nums">5:00</span>
      </div>
      <div className="hidden sm:flex absolute -right-24 top-24 rotate-6 items-center gap-2 rounded-full border border-stone-200 bg-white px-4 py-2 shadow-lg z-10">
        <span className="h-3 w-3 rounded-full bg-timer-yellow" />
        <span className="text-sm font-semibold text-ink">Yellow</span>
        <span className="text-sm text-stone-500 tabular-nums">6:00</span>
      </div>
      <div className="hidden sm:flex absolute -left-16 bottom-6 rotate-3 items-center gap-2 rounded-full border border-stone-200 bg-white px-4 py-2 shadow-lg z-10">
        <span className="h-3 w-3 rounded-full bg-timer-red" />
        <span className="text-sm font-semibold text-ink">Red</span>
        <span className="text-sm text-stone-500 tabular-nums">7:00</span>
      </div>

      {/* The stage itself, in a browser-window frame. */}
      <div className="rounded-3xl border border-stone-200 bg-white p-2.5 shadow-2xl shadow-stone-900/10">
        <div className="flex items-center gap-1.5 px-3 py-2">
          <span className="h-2.5 w-2.5 rounded-full bg-stone-200" />
          <span className="h-2.5 w-2.5 rounded-full bg-stone-200" />
          <span className="h-2.5 w-2.5 rounded-full bg-stone-200" />
        </div>
        <div className="relative rounded-2xl overflow-hidden">
          {/* The branded timing cards — the same images the Zoom app sets as
              virtual backgrounds — cycling green → yellow → red. Green is the
              static base so there is never a blank frame; yellow and red are
              overlays offset by a third of the loop each (see index.css). */}
          <img
            src="/zoom/backgrounds/timer-green-modern.png"
            alt=""
            className="block w-full"
          />
          <img
            src="/zoom/backgrounds/timer-yellow-modern.png"
            alt=""
            className="signal-card-yellow absolute inset-0 w-full"
          />
          <img
            src="/zoom/backgrounds/timer-red-modern.png"
            alt=""
            className="signal-card-red absolute inset-0 w-full"
          />
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="font-mono text-6xl sm:text-7xl font-bold text-white tabular-nums tracking-tight drop-shadow-md">
              05:47
            </span>
            <span className="mt-3 rounded-full bg-black/25 px-4 py-1 text-sm font-medium text-white">
              Standard Speech · 5–7 min
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

// One pill button style per intent, shared by the hero, the header and the
// closing band, so every "Add to Zoom" on the page looks like the same button.
const BTN_PRIMARY = 'inline-flex items-center justify-center rounded-full bg-ink px-7 py-3 text-base font-semibold text-white hover:bg-stone-700 transition-colors'
const BTN_SECONDARY = 'inline-flex items-center justify-center rounded-full border border-stone-300 bg-white px-7 py-3 text-base font-semibold text-ink hover:border-stone-400 hover:bg-stone-50 transition-colors'

export default function Landing() {
  const ADD_TO_ZOOM_URL = import.meta.env.VITE_ZOOM_OAUTH_REDIRECT
  // The screenshot being viewed full size, or null. One at a time, so it lives
  // here rather than in each Shot.
  const [zoomedShot, setZoomedShot] = useState(null)
  return (
    <div className="min-h-screen bg-cream text-ink">
      <header className="sticky top-0 z-30 bg-cream/85 backdrop-blur-md border-b border-stone-200/80">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-3 flex items-center gap-3">
          <a href="#top" className="flex items-center gap-2.5">
            <img
              src="/Toastmasters-Timer-logo.jpg"
              alt="Toastmusters Timer app logo"
              className="h-9 w-9 rounded-xl object-cover"
            />
            <span className="font-display text-lg font-bold">Toastmusters Timer</span>
          </a>
          <nav aria-label="Page sections" className="hidden md:flex items-center gap-1 mx-auto">
            {NAV_LINKS.map((link) => (
              <a
                key={link.href}
                href={link.href}
                className="rounded-full px-3.5 py-1.5 text-sm font-medium text-stone-600 hover:text-ink hover:bg-stone-900/5 transition-colors"
              >
                {link.label}
              </a>
            ))}
          </nav>
          <div className="ml-auto md:ml-0 flex items-center gap-2">
            <Link to="/app" className="hidden sm:inline-flex rounded-full px-4 py-2 text-sm font-semibold text-ink hover:bg-stone-900/5 transition-colors">
              Use in Browser
            </Link>
            <span className="hidden sm:inline-flex">
              <AccountMenu />
            </span>
            <a
              href={ADD_TO_ZOOM_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center rounded-full bg-ink px-4 py-2 text-sm font-semibold text-white hover:bg-stone-700 transition-colors"
            >
              Add to Zoom
            </a>
          </div>
        </div>
      </header>

      <main id="top">
        {/* ——— Hero ——— */}
        <section className="relative overflow-hidden">
          {/* A soft wash of the three signal colors behind the hero, faint
              enough to stay paper, loud enough that the page opens on brand. */}
          <div
            aria-hidden
            className="absolute inset-x-0 top-0 h-[480px] opacity-[0.14] pointer-events-none"
            style={{
              background:
                'radial-gradient(560px 300px at 12% 0%, #10b981, transparent 70%), radial-gradient(560px 300px at 50% -10%, #f59e0b, transparent 70%), radial-gradient(560px 300px at 88% 0%, #ef4444, transparent 70%)',
            }}
          />
          <div className="relative max-w-6xl mx-auto px-4 sm:px-6 pt-16 sm:pt-24 pb-16 text-center">
            {/* Live adoption where a static tagline used to be: real numbers
                are the stronger opener, and unlike a pricing promise they
                can't go stale. */}
            <HeroStats />
            <h1 className="mt-7 font-display text-4xl sm:text-5xl lg:text-[3.5rem] font-extrabold tracking-tight leading-[1.1] max-w-4xl mx-auto">
              Free Online Toastmasters Speech Timer – Run the Timer Role Easily
            </h1>
            <p className="mt-6 text-lg sm:text-xl text-stone-600 max-w-2xl mx-auto leading-relaxed">
              Toastmasters Timer helps you run the Timer role in Toastmasters meetings.
              Use it in your browser or add it to Zoom for automatic virtual backgrounds.
            </p>
            <div className="mt-9 flex flex-col sm:flex-row gap-3 justify-center">
              <a href={ADD_TO_ZOOM_URL} target="_blank" rel="noopener noreferrer" className={BTN_PRIMARY}>
                Add to Zoom
              </a>
              <Link to="/app" className={BTN_SECONDARY}>
                Use in Browser &rarr;
              </Link>
            </div>
            <p className="mt-5 text-sm text-stone-500">
              Already use the Zoom app?{' '}
              <a href={ZOOM_APP_URL} className="font-medium text-ink underline underline-offset-4 decoration-stone-300 hover:decoration-ink transition-colors">Open in Zoom</a>
            </p>

            <HeroTimerMock />
          </div>
        </section>

        <div className="max-w-6xl mx-auto px-4 sm:px-6">
          <TrustedBy />
        </div>

        {/* Directly under the club strip on purpose: the clubs and John are one
            social-proof block — "clubs run it, and a seasoned Toastmaster vouches
            for it" — best read together, before the feature pitch. */}
        <section id="ambassador" className="scroll-mt-24 max-w-3xl mx-auto px-4 sm:px-6 pb-20">
          <figure className="rounded-3xl border border-stone-200 bg-white px-8 py-10 sm:px-12 shadow-sm text-center">
            {/* A real heading, not decoration: it names the section for the
                page outline the way "Trusted by" names the strip above. */}
            <h2 className="inline-flex items-center gap-2 rounded-full bg-stone-100 px-4 py-1.5 text-xs font-semibold uppercase tracking-widest text-stone-600 mb-6">
              Our Founding Ambassador
            </h2>
            <blockquote className="font-display text-2xl sm:text-3xl font-bold leading-snug">
              &ldquo;Everyone is praising the timer on the screen.&rdquo;
            </blockquote>
            <figcaption className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-4 text-left">
              <AmbassadorPhoto />
              <div className="text-center sm:text-left">
                <h3 className="text-base font-semibold">John C.</h3>
                <p className="text-sm text-stone-500">
                  Toastmasters Area Director
                </p>
              </div>
            </figcaption>
            <p className="mt-6 text-sm text-stone-600 leading-relaxed max-w-xl mx-auto text-left">
              John is a member of more than twenty Toastmasters clubs around the world, from
              California to EMEA to Southeast Asia. As Area Director he has introduced the Zoom
              timer App to clubs across his area and globally, and dozens of his suggestions
              have shaped the app you see today.
            </p>
            <p className="mt-4 text-sm text-stone-600 leading-relaxed max-w-xl mx-auto text-left">
              The timer role is now a fun, low-stress way to participate, allowing you to focus
              more on the speakers and less on worrying about the clock.
            </p>
          </figure>
        </section>

        {/* ——— Features ——— */}
        <section id="features" className="scroll-mt-24 max-w-6xl mx-auto px-4 sm:px-6 pb-20">
          <div className="text-center max-w-2xl mx-auto mb-12">
            <h2 className="font-display text-3xl sm:text-4xl font-extrabold tracking-tight">
              Everything the Timer role needs
            </h2>
            <p className="mt-4 text-lg text-stone-600">
              From the first Table Topic to the final report — without touching a stopwatch.
            </p>
          </div>
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((feature) => (
              <div
                key={feature.title}
                className="rounded-3xl border border-stone-200 bg-white p-7 shadow-sm hover:shadow-md hover:-translate-y-0.5 transition-all"
              >
                <div className="relative inline-flex">
                  <span className="inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-stone-100">
                    <feature.icon className="h-5 w-5 text-ink" aria-hidden />
                  </span>
                  <span className={`absolute -right-1 -top-1 h-3 w-3 rounded-full ring-2 ring-white ${feature.dot}`} aria-hidden />
                </div>
                <h3 className="mt-4 font-display text-lg font-bold">{feature.title}</h3>
                <p className="mt-2 text-sm text-stone-600 leading-relaxed">{feature.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Ahead of the step-by-step on purpose. This section answers "what will
            this look like in my meeting?", which is the question a club has
            before installing anything; the steps answer "how do I drive it?",
            which only matters once they have decided. Three cards also scan in
            a fraction of the space six steps take. */}
        <section id="display-modes" className="scroll-mt-24 bg-white border-y border-stone-200 py-20">
          <div className="max-w-6xl mx-auto px-4 sm:px-6">
            <div className="text-center max-w-2xl mx-auto mb-12">
              <h2 className="font-display text-3xl sm:text-4xl font-extrabold tracking-tight">
                Three ways to show the timer
              </h2>
              <p className="mt-4 text-lg text-stone-600">
                Pick the one that fits your club. Switching modes takes one click, and the app remembers your choice for next time.
              </p>
            </div>
            <div className="grid gap-8 sm:grid-cols-3">
              {DISPLAY_MODES.map((mode) => (
                <div key={mode.name} className="rounded-3xl border border-stone-200 bg-cream p-5">
                  <Shot src={mode.src} alt={`${mode.name} mode in Zoom`} hint={mode.hint} onZoom={setZoomedShot} />
                  <h3 className="mt-4 font-display text-lg font-bold">{mode.name}</h3>
                  <p className="mt-2 text-sm text-stone-600 leading-relaxed">{mode.body}</p>
                  <p className="mt-3 text-sm font-medium text-ink">{mode.bestFor}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Sits with the display modes, not after the steps: both answer "what
            will this look like in my meeting?", and these options are choices
            about the modes above. The steps below are the separate question of
            how to drive it. */}
        <section id="tips" className="scroll-mt-24 max-w-6xl mx-auto px-4 sm:px-6 py-20">
          <div className="text-center max-w-2xl mx-auto mb-12">
            <h2 className="font-display text-3xl sm:text-4xl font-extrabold tracking-tight">
              Small things worth knowing
            </h2>
            <p className="mt-4 text-lg text-stone-600">Options that are easy to miss and change how the meeting feels.</p>
          </div>
          <div className="grid gap-8 sm:grid-cols-3">
            {TIPS.map((tip) => (
              <div key={tip.title}>
                <Shot src={tip.src} alt={tip.title} hint={tip.hint} onZoom={setZoomedShot} />
                <h3 className="mt-4 font-display text-lg font-bold">{tip.title}</h3>
                <p className="mt-2 text-sm text-stone-600 leading-relaxed">{tip.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ——— Tutorial ——— */}
        <section id="how-to-zoom" className="scroll-mt-24 bg-white border-y border-stone-200 py-20">
          <div className="max-w-5xl mx-auto px-4 sm:px-6">
            <div className="text-center max-w-2xl mx-auto mb-14">
              <h2 className="font-display text-3xl sm:text-4xl font-extrabold tracking-tight">
                How to use the timer in Zoom
              </h2>
              <p className="mt-4 text-lg text-stone-600">Six steps from joining the meeting to sharing the report.</p>
            </div>
            <ol className="space-y-14">
              {TUTORIAL_STEPS.map((step, index) => (
                <li key={step.title} className="grid gap-6 sm:grid-cols-2 sm:items-center">
                  {/* Text and shot swap sides on alternate steps, so the column
                      of steps reads as a path rather than a table. */}
                  <div className={index % 2 === 1 ? 'sm:order-2' : ''}>
                    <div className="flex items-center gap-3">
                      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-ink text-sm font-bold text-white flex-shrink-0">
                        {index + 1}
                      </span>
                      <h3 className="font-display text-xl font-bold">{step.title}</h3>
                    </div>
                    <p className="mt-3 text-stone-600 leading-relaxed">{step.body}</p>
                  </div>
                  <div className={index % 2 === 1 ? 'sm:order-1' : ''}>
                    <Shot src={step.src} alt={`Step ${index + 1}: ${step.title}`} hint={step.hint} onZoom={setZoomedShot} />
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* ——— Demos ——— */}
        <section id="demos" className="scroll-mt-24 max-w-6xl mx-auto px-4 sm:px-6 py-20">
          <div className="text-center max-w-2xl mx-auto mb-12">
            <h2 className="font-display text-3xl sm:text-4xl font-extrabold tracking-tight">
              See it running
            </h2>
            <p className="mt-4 text-lg text-stone-600">Two minutes of the timer doing its job in a real meeting.</p>
          </div>
          <div className="grid gap-8 lg:grid-cols-2">
            <div className="rounded-3xl border border-stone-200 bg-white p-6 shadow-sm">
              <h3 className="font-display text-lg font-bold mb-4">Quick demo: using in Zoom</h3>
              <div className="rounded-xl overflow-hidden">
                <video
                  src="/zoom/use-app-demo.mp4"
                  preload="none"
                  poster="/use-app-demo-poster.jpg"
                  controls
                  playsInline
                  className="w-full rounded-xl"
                  aria-label="Demo video showing Toastmasters Timer with Zoom virtual background color changes"
                  onPlay={() => trackEvent('quick_demo_played', { page: 'landing' })}
                />
              </div>
              <a href="/toastmasters-timer-zoom-demo" className="inline-block mt-4 text-sm font-medium text-ink underline underline-offset-4 decoration-stone-300 hover:decoration-ink transition-colors">Watch on dedicated page &rarr;</a>
            </div>
            <div className="rounded-3xl border border-stone-200 bg-white p-6 shadow-sm">
              <h3 className="font-display text-lg font-bold mb-4">Watch the full product demo</h3>
              <div className="rounded-xl overflow-hidden">
                <YouTubePlayer
                  videoId="1VkED9sXE6Q"
                  title="Toastmasters Timer – Product Demo"
                  page="landing"
                />
              </div>
              <a href="/toastmasters-timer-demo" className="inline-block mt-4 text-sm font-medium text-ink underline underline-offset-4 decoration-stone-300 hover:decoration-ink transition-colors">Watch on dedicated page &rarr;</a>
            </div>
          </div>
        </section>

        {/* ——— Timer role explainer ——— */}
        <section id="timer-role" className="scroll-mt-24 max-w-3xl mx-auto px-4 sm:px-6 pb-20">
          <h2 className="font-display text-3xl font-extrabold tracking-tight mb-4">What is the Timer role in Toastmasters?</h2>
          <p className="text-stone-600 leading-relaxed mb-10">
            The Timer is one of the most important meeting roles in Toastmasters. The Timer tracks how long each speaker talks and signals them using colored lights — green, yellow, and red — so they stay within their allotted time. Keeping speeches on time ensures the meeting runs smoothly and every speaker gets a fair chance to practice.
          </p>

          <h2 className="font-display text-2xl font-extrabold tracking-tight mb-3">Standard Toastmasters timing rules</h2>
          <p className="text-stone-600 leading-relaxed mb-6">
            Each speech type has its own time range. The timer shows green when the minimum time is reached, yellow at the midpoint, and red at the maximum. Speakers who finish before green or after red may be disqualified from awards.
          </p>
          <ul className="rounded-3xl border border-stone-200 bg-white shadow-sm divide-y divide-stone-100 overflow-hidden">
            <li className="flex flex-col sm:flex-row sm:justify-between gap-1 px-6 py-4">
              <span className="font-semibold">Standard Speech (5–7 min)</span>
              <span className="text-stone-600 tabular-nums">🟢 5:00 &nbsp; 🟡 6:00 &nbsp; 🔴 7:00</span>
            </li>
            <li className="flex flex-col sm:flex-row sm:justify-between gap-1 px-6 py-4">
              <span className="font-semibold">Table Topics (1–2 min)</span>
              <span className="text-stone-600 tabular-nums">🟢 1:00 &nbsp; 🟡 1:30 &nbsp; 🔴 2:00</span>
            </li>
            <li className="flex flex-col sm:flex-row sm:justify-between gap-1 px-6 py-4">
              <span className="font-semibold">Evaluation (2–3 min)</span>
              <span className="text-stone-600 tabular-nums">🟢 2:00 &nbsp; 🟡 2:30 &nbsp; 🔴 3:00</span>
            </li>
            <li className="flex flex-col sm:flex-row sm:justify-between gap-1 px-6 py-4">
              <span className="font-semibold">Longer Speech (7–9 min)</span>
              <span className="text-stone-600 tabular-nums">🟢 7:00 &nbsp; 🟡 8:00 &nbsp; 🔴 9:00</span>
            </li>
          </ul>
          <p className="text-sm text-stone-500 mt-4">
            Toastmasters Timer is pre-loaded with these rules so you can start timing immediately — no manual setup required.
          </p>
        </section>

        {/* ——— Closing CTA ——— */}
        <section className="max-w-6xl mx-auto px-4 sm:px-6 pb-24">
          <div className="relative overflow-hidden rounded-[2.5rem] bg-ink px-8 py-16 sm:py-20 text-center">
            {/* The signature strip, as the band's only decoration. */}
            <div
              aria-hidden
              className="absolute inset-x-0 top-0 h-1.5"
              style={{ background: 'linear-gradient(90deg, #10b981 0%, #f59e0b 50%, #ef4444 100%)' }}
            />
            <h2 className="font-display text-3xl sm:text-4xl font-extrabold tracking-tight text-white max-w-2xl mx-auto">
              Ready for your next meeting?
            </h2>
            <p className="mt-4 text-lg text-stone-300 max-w-xl mx-auto">
              Open it in your browser right now, or add it to Zoom before the next club night.
            </p>
            <div className="mt-8 flex flex-col sm:flex-row gap-3 justify-center">
              <a
                href={ADD_TO_ZOOM_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center rounded-full bg-white px-7 py-3 text-base font-semibold text-ink hover:bg-stone-200 transition-colors"
              >
                Add to Zoom
              </a>
              <Link
                to="/app"
                className="inline-flex items-center justify-center rounded-full border border-white/30 px-7 py-3 text-base font-semibold text-white hover:bg-white/10 transition-colors"
              >
                Use in Browser &rarr;
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="bg-white border-t border-stone-200 py-12 px-4 sm:px-6">
        <div className="max-w-6xl mx-auto grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-8">
          <div>
            <h4 className="text-sm font-semibold mb-3">Resources</h4>
            <ul className="space-y-2">
              <li><a href="/toastmasters-timer-role-guide" className="text-sm text-stone-500 hover:text-ink transition-colors">Timer Role Guide</a></li>
              <li><a href="/toastmasters-timer-script" className="text-sm text-stone-500 hover:text-ink transition-colors">Timer Script</a></li>
              <li><a href="/toastmasters-speech-types-and-timing" className="text-sm text-stone-500 hover:text-ink transition-colors">Speech Types &amp; Timing</a></li>
              <li><a href="/toastmasters-timing-chart" className="text-sm text-stone-500 hover:text-ink transition-colors">Timing Chart</a></li>
              <li><a href="/table-topics-timer" className="text-sm text-stone-500 hover:text-ink transition-colors">Table Topics Timer</a></li>
              <li><a href="/toastmasters-speech-contest-timing-rules" className="text-sm text-stone-500 hover:text-ink transition-colors">Contest Timing Rules</a></li>
              <li><a href="/how-to-use-zoom-for-toastmasters" className="text-sm text-stone-500 hover:text-ink transition-colors">Zoom for Toastmasters</a></li>
              <li><a href="/toastmasters-zoom-timer-backgrounds" className="text-sm text-stone-500 hover:text-ink transition-colors">Free Zoom Backgrounds</a></li>
              <li><a href="/best-toastmasters-timer-apps" className="text-sm text-stone-500 hover:text-ink transition-colors">Timer Apps Compared</a></li>
              <li><a href="/toastmasters-timer-demo" className="text-sm text-stone-500 hover:text-ink transition-colors">Product Demo</a></li>
              <li><a href="/toastmasters-timer-zoom-demo" className="text-sm text-stone-500 hover:text-ink transition-colors">Zoom Demo</a></li>
            </ul>
          </div>
          <div>
            <h4 className="text-sm font-semibold mb-3">Legal</h4>
            <ul className="space-y-2">
              <li><a href="/privacy" className="text-sm text-stone-500 hover:text-ink transition-colors">Privacy Policy</a></li>
              <li><a href="/terms-of-use" className="text-sm text-stone-500 hover:text-ink transition-colors">Terms of Use</a></li>
              <li><a href="/support" className="text-sm text-stone-500 hover:text-ink transition-colors">Support</a></li>
              <li><a href="/documentation" className="text-sm text-stone-500 hover:text-ink transition-colors">Documentation</a></li>
            </ul>
          </div>
          <div>
            <h4 className="text-sm font-semibold mb-3">Get Started</h4>
            <ul className="space-y-2">
              <li><Link to="/app" className="text-sm text-stone-500 hover:text-ink transition-colors">Start Timer</Link></li>
            </ul>
          </div>
          <div>
            <h4 className="text-sm font-semibold mb-3">Tools</h4>
            <ul className="space-y-2">
              {TOOLS.map((tool) => (
                <li key={tool.slug}>
                  {tool.slug === 'timer' ? (
                    <span className="text-sm text-stone-500">{tool.name} (this site)</span>
                  ) : (
                    <a href={tool.url} className="text-sm text-stone-500 hover:text-ink transition-colors">{tool.name}</a>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </div>
        <p className="text-xs text-stone-400 mt-10 text-center">&copy; 2026 Toastmusters Timer. Not affiliated with <a href="https://www.toastmasters.org/" target="_blank" rel="noopener noreferrer" className="underline hover:text-stone-500">Toastmasters International</a>.</p>
      </footer>

      <Lightbox shot={zoomedShot} onClose={() => setZoomedShot(null)} />
    </div>
  )
}
