import React from 'react'
import { Link } from 'react-router-dom'

/**
 * What a page answers when the feature behind it is not released.
 *
 * The release flags (worker/flags.js) make a dark feature's endpoints answer a
 * bare 404, so its pages say the same thing: nothing here, with a way home.
 * Nothing on screen mentions a flag, the same way nothing on the wire does.
 */
export default function NotFoundView() {
  return (
    <div className="min-h-screen bg-gray-900 text-white">
      <header className="border-b border-white/10 bg-black/25 backdrop-blur-md">
        <div className="mx-auto flex max-w-4xl items-center gap-3 px-4 py-4">
          <Link to="/" className="flex items-center gap-3 text-white no-underline">
            <img src="/Toastmasters-Timer-logo.jpg" alt="Toastmusters Timer" className="h-10 w-10 rounded-xl object-cover shadow-sm ring-1 ring-white/20" />
            <h1 className="text-xl font-semibold">Toastmusters Timer</h1>
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-2xl px-4 py-12">
        <section className="rounded-2xl border border-white/10 bg-black/30 px-6 py-8" data-testid="not-found">
          <h2 className="text-2xl font-bold">Page not found</h2>
          <p className="mt-3 text-gray-300">There is nothing at this address.</p>
          <Link
            to="/timer/app"
            className="mt-6 inline-flex rounded-lg bg-blue-500 px-4 py-2 font-semibold text-white no-underline hover:bg-blue-600"
          >
            Open the timer
          </Link>
        </section>
      </main>
    </div>
  )
}
