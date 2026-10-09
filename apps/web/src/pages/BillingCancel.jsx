import React, { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { trackEvent } from '../utils/posthog'

/** Where Stripe sends someone who backed out of Checkout. Nothing was charged. */
export default function BillingCancel() {
  useEffect(() => {
    trackEvent('checkout_cancel_page_viewed')
  }, [])

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
          <h2 className="text-2xl font-bold text-white">No charge was made</h2>
          <p className="mt-4 text-lg text-gray-300">
            You closed the checkout page. The free timer keeps working exactly as before, and you
            can upgrade any time from the Pro button in the app.
          </p>
          <div className="mt-8 flex flex-wrap gap-3 justify-center">
            <Link
              to="/"
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-white/10 text-white font-medium hover:bg-white/20 transition-colors no-underline"
            >
              Back to home
            </Link>
          </div>
        </div>
      </main>
    </div>
  )
}
