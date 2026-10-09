import React, { useEffect, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { trackEvent } from '../utils/posthog'
import YouTubePlayer from '../components/YouTubePlayer'

export default function OAuthRedirect() {
  const [searchParams] = useSearchParams()
  const hasFired = useRef(false)

  useEffect(() => {
    if (hasFired.current) return
    hasFired.current = true

    // Only the shape of the callback, never its values: `code` is a live OAuth
    // credential and must not land in analytics.
    trackEvent('zoom_app_installed', {
      source: 'oauth_redirect',
      has_code: searchParams.has('code'),
      has_state: searchParams.has('state'),
    })
  }, [searchParams])

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
          <h2 className="text-2xl font-bold text-white">
            Zoom app installed successfully
          </h2>
          <p className="mt-4 text-lg text-gray-300">
            Open Zoom and start or join a meeting to use Toastmaster Timer. The app will appear in your meeting toolbar.
          </p>
          <p className="mt-6 text-gray-400">
            Return to Zoom:
          </p>
          <div className="mt-3 flex flex-wrap gap-3 justify-center">
            <a
              type="button"
              target="_blank"
              href="https://marketplace.zoom.us/zoomapp/DsFHK5sNQs2_VFyeQky2sg/context/meeting/target/launch/deeplink"
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-white/10 text-white font-medium hover:bg-white/20 transition-colors cursor-pointer border-0 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              Open Zoom app
            </a>
            <a
              href="https://app.zoom.us"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-white/10 text-white font-medium hover:bg-white/20 transition-colors no-underline"
            >
              Open Zoom in browser
            </a>
          </div>
          <p className="mt-4 text-sm text-gray-500">
            You can also close this tab and open Zoom yourself.
          </p>
        </div>

        <div className="rounded-2xl bg-black/30 backdrop-blur-md border border-white/10 shadow-2xl px-8 py-8 mt-6">
          <h3 className="text-lg font-semibold text-white mb-4">Quick Demo: Using in Zoom</h3>
          <div className="rounded-xl overflow-hidden">
            <video
              src="/zoom/use-app-demo.mp4"
              preload="none"
              poster="/use-app-demo-poster.jpg"
              controls
              playsInline
              className="w-full rounded-xl"
              onPlay={() => trackEvent('quick_demo_played', { page: 'oauth_redirect' })}
            />
          </div>
        </div>

        <div className="rounded-2xl bg-black/30 backdrop-blur-md border border-white/10 shadow-2xl px-8 py-8 mt-6">
          <h3 className="text-lg font-semibold text-white mb-4">Watch the Full Product Demo</h3>
          <div className="rounded-xl overflow-hidden">
            <YouTubePlayer
              videoId="1VkED9sXE6Q"
              title="Toastmasters Timer – Product Demo"
              page="oauth_redirect"
            />
          </div>
        </div>
      </main>
    </div>
  )
}
