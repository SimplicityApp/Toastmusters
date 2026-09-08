import React, { useEffect, useState } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import { trackEvent } from '../utils/posthog'

/**
 * Where Stripe sends the buyer after Checkout.
 *
 * The purchase started inside Zoom, so this tab has no session: it learns one
 * bit — whether this Checkout session was paid — from the id Stripe put in the
 * URL, and tells the buyer to go back to Zoom, where the app is already polling
 * for the change.
 */
export default function BillingSuccess() {
  const [searchParams] = useSearchParams()
  const sessionId = searchParams.get('session_id')
  const [state, setState] = useState('checking') // checking | paid | pending | unknown

  useEffect(() => {
    trackEvent('checkout_success_page_viewed', { has_session_id: Boolean(sessionId) })
    if (!sessionId) {
      setState('unknown')
      return
    }
    let cancelled = false
    fetch(`/api/billing/checkout-status?session_id=${encodeURIComponent(sessionId)}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { paid: false }))
      .then((body) => {
        if (!cancelled) setState(body?.paid ? 'paid' : 'pending')
      })
      .catch(() => {
        if (!cancelled) setState('unknown')
      })
    return () => {
      cancelled = true
    }
  }, [sessionId])

  const headline =
    state === 'paid'
      ? 'You are on Pro'
      : state === 'checking'
        ? 'Confirming your purchase…'
        : state === 'pending'
          ? 'Payment received, activating…'
          : 'Thanks for subscribing'

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      <header className="bg-black/25 backdrop-blur-md border-b border-white/10">
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center gap-3">
          <img
            src="/Toastmasters-Timer-logo.jpg"
            alt="Toastmusters Timer"
            className="h-10 w-10 rounded-xl object-cover shadow-sm ring-1 ring-white/20"
          />
          <h1 className="text-xl font-semibold text-white">Toastmusters Timer</h1>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-16 text-center">
        <div className="rounded-2xl bg-black/30 backdrop-blur-md border border-white/10 shadow-2xl px-8 py-12">
          <div className="mx-auto w-16 h-16 rounded-full bg-green-500/20 flex items-center justify-center mb-6">
            <svg className="w-8 h-8 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h2 className="text-2xl font-bold text-white">{headline}</h2>
          <p className="mt-4 text-lg text-gray-300">
            Go back to Zoom. The timer app picks up your plan on its own within a minute; if it
            does not, use <span className="font-medium text-white">I have paid, refresh</span> there.
          </p>
          <p className="mt-6 text-sm text-gray-400">
            Your receipt comes from Stripe by email. You can manage or cancel the plan any time from
            the app&apos;s Pro menu.
          </p>
          <div className="mt-8 flex flex-wrap gap-3 justify-center">
            <a
              href="https://marketplace.zoom.us/zoomapp/DsFHK5sNQs2_VFyeQky2sg/context/meeting/target/launch/deeplink"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-white/10 text-white font-medium hover:bg-white/20 transition-colors no-underline"
            >
              Open Zoom app
            </a>
            <Link
              to="/app"
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-white/10 text-white font-medium hover:bg-white/20 transition-colors no-underline"
            >
              Use in browser
            </Link>
          </div>
        </div>
      </main>
    </div>
  )
}
