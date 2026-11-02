import { useEffect, useRef } from 'react'
import { trackEvent } from '../utils/posthog'

// Load the YT IFrame API script once globally
let apiReady = typeof window !== 'undefined' && window.YT?.Player
  ? Promise.resolve()
  : null

function loadApi() {
  if (apiReady) return apiReady
  apiReady = new Promise((resolve) => {
    const prev = window.onYouTubeIframeAPIReady
    window.onYouTubeIframeAPIReady = () => { prev?.(); resolve() }
    const tag = document.createElement('script')
    tag.src = 'https://www.youtube.com/iframe_api'
    document.head.appendChild(tag)
  })
  return apiReady
}

// `autoplay` is for a player that only mounts after a click (the home page's demo popup): that
// click is the gesture browsers want, so the video can start straight away.
export default function YouTubePlayer({ videoId, title, page, autoplay = false }) {
  const containerRef = useRef(null)
  const hasFiredRef = useRef(false)

  useEffect(() => {
    let player
    loadApi().then(() => {
      if (!containerRef.current) return
      player = new window.YT.Player(containerRef.current, {
        width: '100%',
        height: '100%',
        videoId,
        playerVars: { rel: 0, playsinline: 1, ...(autoplay ? { autoplay: 1 } : {}) },
        events: {
          onStateChange: ({ data }) => {
            if (data === window.YT.PlayerState.PLAYING && !hasFiredRef.current) {
              hasFiredRef.current = true
              trackEvent('full_demo_played', { page })
            }
          }
        }
      })
    })
    return () => { player?.destroy() }
  }, [videoId, page, autoplay])

  // The API swaps the element it is given for an iframe and drops that element's
  // styles, so the 16:9 box has to be a parent it leaves alone; the iframe then fills it.
  return (
    <div className="w-full" style={{ aspectRatio: '16/9' }} title={title}>
      <div ref={containerRef} className="h-full w-full" />
    </div>
  )
}
