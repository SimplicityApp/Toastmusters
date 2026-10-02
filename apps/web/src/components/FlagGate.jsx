import { useFlag } from '../hooks/useFlag'
import NotFoundView from './NotFoundView'

/**
 * A whole page behind a release flag (worker/flags.js), wrapped at the route.
 *
 * Until the flags have landed it shows `fallback`; while the flag is off it is
 * the not-found view. Either way the page itself is never mounted, so nothing
 * in it (activating a code, spending a mailed token, loading a roster) can run
 * against a feature that is not released.
 */
export default function FlagGate({ flag, fallback = null, children }) {
  const { enabled, known } = useFlag(flag)
  if (!known) return fallback
  if (!enabled) return <NotFoundView />
  return children
}
