import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Users, ExternalLink, ShieldCheck, LogOut, Upload, Trash2, Pencil, MoreHorizontal } from 'lucide-react'
import { refreshClub } from '@toastmaster-timer/shared'
import { signInUrl } from '../utils/webIdentity'
import { trackEvent } from '../utils/posthog'

/**
 * The officer's console: who is in the club, what they may do, and the kit.
 *
 * Web only, deliberately. An officer reviewing their roster is not in a
 * meeting, and the second door — a link mailed to the club's billing address —
 * cannot open inside the Zoom sidebar at all, so nothing in the Zoom app needs
 * to know this page exists.
 *
 * Two doors land here. Signing in with Zoom is the everyday path: the club is
 * the one that account is in. The mailed link names its own club, so it works
 * for whoever holds the billing mailbox. Both reach one permission check in the
 * Worker, and differ only in the actor they carry.
 *
 * The roster is people, not devices (#167): the owner, who pays and is fixed,
 * then up to 3 accounts the code let in. Remove frees a place and lets the
 * account rejoin with the code; Block, tucked in a row's "…" menu because it
 * is rare, frees it and keeps the code from letting them back in.
 */

const ROLE_LABELS = { admin: 'Admin', editor: 'Editor', member: 'Member' }

const DATE_FORMAT = { day: 'numeric', month: 'short' }
const shortDate = (value) =>
  typeof value === 'number' && value > 0 ? new Date(value).toLocaleDateString(undefined, DATE_FORMAT) : '—'

const removeCopy = (name) =>
  `Remove ${name}? They lose the club's Pro at their next open and the place is freed. They can rejoin with the code; to keep them out, use Block.`
const blockCopy = (name) =>
  `Block ${name}? They lose the club's Pro at their next open, the place is freed, and the code won't let them back in until you unblock them.`

/** Every console call carries the cookie: the Zoom sign-in, or the billing link's. */
async function api(path, { method = 'GET', body, form } = {}) {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    ...(form ? { body: form } : body ? { body: JSON.stringify(body) } : {}),
  })
  const json = await response.json().catch(() => ({}))
  return { ok: response.ok, status: response.status, body: json }
}

// ---------------------------------------------------------------------------

/** The two doors, shown to anyone the roster refused. */
function DoorsPanel({ reason }) {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)

  const requestLink = async (event) => {
    event.preventDefault()
    if (busy || !email.trim()) return
    setBusy(true)
    // Always 200, whatever the address: the endpoint must not confirm which
    // address owns a club. So "we've sent it" is the only thing we can say.
    await api('/api/club/magic-link', { method: 'POST', body: { email } }).catch(() => {})
    setBusy(false)
    setSent(true)
    trackEvent('club_admin_link_requested', { surface: 'web' })
  }

  return (
    <div className="mt-6 rounded-2xl border border-white/10 bg-black/30 px-6 py-8">
      <h2 className="text-xl font-bold">Manage your club</h2>
      <p className="mt-2 text-gray-300" role={reason ? 'alert' : undefined}>
        {reason === 'forbidden'
          ? 'This account is on the club, but it is not an admin. Ask a club admin to promote you, or use the billing address below.'
          : 'Sign in with the Zoom account that runs your club, or ask for a link at the address that pays for it.'}
      </p>

      <a
        href={signInUrl('/club/admin')}
        className="mt-5 inline-flex items-center gap-2 rounded-lg bg-white px-4 py-2 font-semibold text-gray-900 no-underline hover:bg-gray-100"
        data-testid="sign-in-with-zoom"
      >
        Sign in with Zoom
      </a>

      <form onSubmit={requestLink} className="mt-8 border-t border-white/10 pt-6">
        <label htmlFor="billing-email" className="block font-medium text-white">
          Admin moved on?
        </label>
        <p className="mt-1 mb-3 text-sm text-gray-400">
          We&apos;ll mail a sign-in link to the address that pays for the club.
        </p>
        <div className="flex gap-2">
          <input
            id="billing-email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="treasurer@example.com"
            className="flex-1 rounded-md border border-white/20 bg-black/30 px-3 py-2 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            type="submit"
            disabled={busy || !email.trim()}
            className="rounded-lg bg-white/10 px-4 py-2 font-semibold text-white hover:bg-white/20 disabled:opacity-50"
          >
            {busy ? 'Sending…' : 'Send link'}
          </button>
        </div>
        {sent && (
          <p className="mt-3 text-sm text-gray-300" role="status">
            If that address pays for a club, a link is on its way. It works once and expires in 15 minutes.
            Check the spam folder before asking for another.
          </p>
        )}
      </form>
    </div>
  )
}

/**
 * One person in the club.
 *
 * The label is the one piece of this page that had nothing to show. Zoom's
 * `screenName` is reachable through `getUserContext` and would fill the roster
 * in by itself, but it is personal data this product has never collected — so
 * until that is a decision somebody has made, an officer looking at their own
 * club sees "You", and anyone else is whatever an admin typed. A raw uid is the
 * fallback, not the answer.
 *
 * The owner's row says "Owner" where the role select would be, with no "…":
 * nobody can remove, block or demote the account that pays.
 */
function MemberRow({ member, isYou, busy, onRole, onBlock, onName }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(member.displayName || '')
  const [menuOpen, setMenuOpen] = useState(false)
  const label = member.displayName || (isYou ? 'You' : member.uid)

  const saveName = async (event) => {
    event.preventDefault()
    setEditing(false)
    await onName(member.uid, draft)
  }

  return (
    <li className="border-t border-white/10 py-4 first:border-t-0">
      <div className="flex flex-wrap items-center gap-3">
        {editing ? (
          <form onSubmit={saveName} className="flex items-center gap-2">
            <label className="sr-only" htmlFor={`name-${member.uid}`}>Name for this person</label>
            <input
              id={`name-${member.uid}`}
              value={draft}
              maxLength={60}
              autoFocus
              placeholder="Sarah (VPE)"
              onChange={(event) => setDraft(event.target.value)}
              className="rounded-md border border-white/20 bg-black/40 px-2 py-1 text-sm text-white placeholder-gray-500"
            />
            <button type="submit" disabled={busy} className="text-xs font-semibold text-blue-300 hover:text-blue-200 disabled:opacity-50">
              Save
            </button>
            <button type="button" onClick={() => { setEditing(false); setDraft(member.displayName || '') }} className="text-xs text-gray-400 hover:text-gray-200">
              Cancel
            </button>
          </form>
        ) : (
          <>
            <span
              title={member.uid}
              className={`font-semibold text-white ${member.displayName || isYou ? '' : 'font-mono text-sm break-all'}`}
            >
              {label}
            </span>
            <button
              type="button"
              onClick={() => setEditing(true)}
              disabled={busy}
              className="inline-flex items-center gap-1 text-xs text-gray-400 hover:text-gray-100 disabled:opacity-50"
            >
              <Pencil className="h-3 w-3" />
              {member.displayName ? 'Rename' : 'Name'}
            </button>
          </>
        )}
        {member.isOwner ? (
          <span className="ml-auto rounded-full bg-amber-400/20 px-2 py-0.5 text-xs font-medium text-amber-200">Owner</span>
        ) : (
          <div className="relative ml-auto flex items-center gap-2">
            <label className="sr-only" htmlFor={`role-${member.uid}`}>
              Role for {label}
            </label>
            <select
              id={`role-${member.uid}`}
              value={member.role}
              disabled={busy}
              onChange={(event) => onRole(member, label, event.target.value)}
              className="rounded-md border border-white/20 bg-black/40 px-2 py-1 text-sm text-white disabled:opacity-50"
            >
              <option value="admin">Admin</option>
              <option value="editor">Editor</option>
              <option value="member">Member</option>
              <option value="revoked">Remove</option>
            </select>
            <button
              type="button"
              aria-label={`More options for ${label}`}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              disabled={busy}
              onClick={() => setMenuOpen((open) => !open)}
              className="rounded-md p-1 text-gray-400 hover:bg-white/10 hover:text-gray-100 disabled:opacity-50"
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
            {menuOpen && (
              <div role="menu" className="absolute right-0 top-full z-10 mt-1 rounded-md border border-white/10 bg-gray-800 py-1 shadow-lg">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                    onBlock(member, label)
                  }}
                  className="block w-full px-4 py-1.5 text-left text-sm text-red-300 hover:bg-white/10"
                >
                  Block
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </li>
  )
}

/** The brand kit, self-serve at last. */
function KitEditor({ kit, clubName, onSaved }) {
  const [name, setName] = useState(clubName || '')
  const [primaryColor, setPrimaryColor] = useState(kit?.primaryColor || '#772432')
  const [showOnCards, setShowOnCards] = useState(kit?.showOnCards !== false)
  const [showOnReports, setShowOnReports] = useState(kit?.showOnReports !== false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [saved, setSaved] = useState(false)
  const fileRef = useRef(null)

  const submit = async (event, { removeLogo = false } = {}) => {
    event?.preventDefault?.()
    setBusy(true)
    setError(null)
    setSaved(false)

    const file = removeLogo ? null : fileRef.current?.files?.[0]
    // Multipart only when there is a file: a colour change should not have to
    // carry an upload envelope.
    const form = new FormData()
    form.append('name', name)
    form.append('primaryColor', primaryColor)
    form.append('showOnCards', String(showOnCards))
    form.append('showOnReports', String(showOnReports))
    if (removeLogo) form.append('removeLogo', 'true')
    if (file) form.append('logo', file)

    const result = file
      ? await api('/api/club/kit', { method: 'PUT', form })
      : await api('/api/club/kit', {
        method: 'PUT',
        body: { name, primaryColor, showOnCards, showOnReports, ...(removeLogo ? { removeLogo: true } : {}) },
      })

    setBusy(false)
    if (!result.ok) {
      setError(KIT_ERRORS[result.body?.error] || 'Could not save the brand kit. Please try again.')
      return
    }
    if (fileRef.current) fileRef.current.value = ''
    setSaved(true)
    onSaved?.(result.body)
    // The admin is usually looking at their own timer in the next tab, so pull
    // the new kit down here rather than making them wait for the next open.
    refreshClub().catch(() => {})
  }

  return (
    <form onSubmit={submit}>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="kit-name" className="block text-sm font-medium text-gray-200">Club name</label>
          <input
            id="kit-name"
            value={name}
            maxLength={80}
            onChange={(event) => setName(event.target.value)}
            className="mt-1 w-full rounded-md border border-white/20 bg-black/30 px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label htmlFor="kit-color" className="block text-sm font-medium text-gray-200">Primary colour</label>
          <div className="mt-1 flex items-center gap-2">
            <input
              id="kit-color"
              type="color"
              value={primaryColor}
              onChange={(event) => setPrimaryColor(event.target.value)}
              className="h-10 w-14 rounded-md border border-white/20 bg-black/30"
            />
            <span className="font-mono text-sm uppercase text-gray-300">{primaryColor}</span>
          </div>
        </div>
      </div>

      <div className="mt-4">
        <label htmlFor="kit-logo" className="block text-sm font-medium text-gray-200">Logo</label>
        <p className="mt-1 text-xs text-gray-400">
          A square PNG with a transparent background works best. Without one, the badge is name-only.
        </p>
        <div className="mt-2 flex items-center gap-3">
          {kit?.logoUrl && (
            <img src={kit.logoUrl} alt="" className="h-12 w-12 rounded-lg bg-white/10 object-contain" />
          )}
          <input
            id="kit-logo"
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="text-sm text-gray-300 file:mr-3 file:rounded-md file:border-0 file:bg-white/10 file:px-3 file:py-2 file:text-white"
          />
          {kit?.logoUrl && (
            <button
              type="button"
              disabled={busy}
              onClick={(event) => submit(event, { removeLogo: true })}
              className="text-xs text-gray-400 hover:text-gray-100 disabled:opacity-50"
            >
              Remove logo
            </button>
          )}
        </div>
      </div>

      <div className="mt-4 space-y-2">
        {[
          ['showOnCards', showOnCards, setShowOnCards, 'Show the badge on timer cards'],
          ['showOnReports', showOnReports, setShowOnReports, 'Show the header on reports'],
        ].map(([id, value, setValue, label]) => (
          <label key={id} htmlFor={id} className="flex items-center gap-2 text-sm text-gray-200">
            <input
              id={id}
              type="checkbox"
              checked={value}
              onChange={(event) => setValue(event.target.checked)}
              className="h-4 w-4 rounded border-white/30 bg-black/30"
            />
            {label}
          </label>
        ))}
      </div>

      <div className="mt-5 flex items-center gap-3">
        <button
          type="submit"
          disabled={busy || !name.trim()}
          className="inline-flex items-center gap-2 rounded-lg bg-blue-500 px-4 py-2 font-semibold text-white hover:bg-blue-600 disabled:opacity-60"
        >
          <Upload className="h-4 w-4" />
          {busy ? 'Saving…' : 'Save brand kit'}
        </button>
        {saved && <span className="text-sm text-green-300" role="status">Saved. Every device picks it up on its next refresh.</span>}
      </div>
      {error && <p className="mt-3 text-sm text-red-300" role="alert">{error}</p>}
    </form>
  )
}

const CARD_COLORS = ['blue', 'green', 'yellow', 'red']
const CARD_LABELS = { blue: 'Idle (blue)', green: 'Green', yellow: 'Yellow', red: 'Red' }

/**
 * The club's card set, as the console shows it. Read-only apart from Remove:
 * a set is published from a timer's card picker, where the artwork already
 * is, not uploaded here.
 *
 * The images are private, so they are fetched with the console's credentials
 * and shown from object URLs rather than linked.
 */
function ClubCards({ cards, clubName, onRemoved }) {
  const [urls, setUrls] = useState({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!cards?.images) return undefined
    let cancelled = false
    const minted = []
    Promise.all(
      Object.entries(cards.images).map(async ([color, hash]) => {
        try {
          const response = await fetch(`/api/club/cards/${hash}`, { credentials: 'same-origin' })
          if (!response.ok) return null
          const url = URL.createObjectURL(await response.blob())
          minted.push(url)
          return [color, url]
        } catch {
          return null
        }
      })
    ).then((entries) => {
      if (!cancelled) setUrls(Object.fromEntries(entries.filter(Boolean)))
    })
    return () => {
      cancelled = true
      minted.forEach((url) => URL.revokeObjectURL(url))
    }
  }, [cards])

  if (!cards?.images) {
    return (
      <p className="mt-3 text-sm text-gray-300">
        No card set yet. An admin or editor shares one from <strong>Card Images</strong> in the timer, and every
        club device shows it.
      </p>
    )
  }

  const remove = async () => {
    setBusy(true)
    setError(null)
    const result = await api('/api/club/cards', { method: 'DELETE' })
    setBusy(false)
    if (!result.ok) {
      setError('Could not remove the card set. Please try again.')
      return
    }
    trackEvent('club_cards_removed', { surface: 'web' })
    onRemoved?.()
  }

  return (
    <div className="mt-3">
      <p className="text-sm text-gray-200">
        {cards.label || `${clubName || 'Club'} cards`}
        {cards.publishedAt ? <span className="text-gray-400"> · shared {shortDate(cards.publishedAt)}</span> : null}
      </p>
      <div className="mt-2 grid grid-cols-4 gap-2">
        {CARD_COLORS.map((color) =>
          urls[color] ? (
            <img
              key={color}
              src={urls[color]}
              alt={`${CARD_LABELS[color]} card`}
              className="aspect-video w-full rounded border border-white/10 object-cover"
            />
          ) : (
            <div
              key={color}
              className="flex aspect-video w-full items-center justify-center rounded border border-dashed border-white/10 text-center text-xs text-gray-500"
            >
              {cards.images[color] ? '…' : 'Classic'}
            </div>
          )
        )}
      </div>
      <button
        onClick={remove}
        disabled={busy}
        className="mt-3 inline-flex items-center gap-2 rounded-lg bg-white/10 px-3 py-1.5 text-sm text-white hover:bg-white/20 disabled:opacity-60"
      >
        <Trash2 className="h-4 w-4" />
        Remove card set
      </button>
      {error && <p className="mt-2 text-sm text-red-300">{error}</p>}
    </div>
  )
}

const KIT_ERRORS = {
  invalid_name: 'A club needs a name, and it has to fit in 80 characters.',
  invalid_color: 'Pick a colour in #rrggbb form.',
  logo_too_large: 'That logo is over 1 MB. Try a smaller PNG.',
  invalid_logo_type: 'Logos can be PNG, JPEG, WebP or GIF.',
  forbidden: 'Only a club admin can edit the brand kit.',
}

const ROLE_ERRORS = {
  last_admin: 'A club needs at least one admin. Promote somebody else first.',
  owner: 'The club’s owner pays for it, so nobody can remove, block or demote them.',
  forbidden: 'Only a club admin can change roles.',
}

// ---------------------------------------------------------------------------

export default function ClubAdmin() {
  const [roster, setRoster] = useState(null)
  const [phase, setPhase] = useState('loading') // loading | ready | doors | error
  const [reason, setReason] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const opened = useRef(false)

  const load = useCallback(async () => {
    const result = await api('/api/club/roster')
    if (result.status === 401) {
      setPhase('doors')
      setReason(null)
      return null
    }
    if (result.status === 403) {
      setPhase('doors')
      setReason('forbidden')
      return null
    }
    if (!result.ok) {
      setPhase('error')
      setError('Could not load your club. Please try again.')
      return null
    }
    setRoster(result.body)
    setPhase('ready')
    return result.body
  }, [])

  useEffect(() => {
    load().then((body) => {
      if (!body || opened.current) return
      opened.current = true
      trackEvent('club_admin_opened', {
        surface: 'web',
        via: body.actor?.type === 'billing' ? 'billing_link' : 'zoom',
        club_id: body.club?.id ?? null,
      })
    })
  }, [load])

  const handleRole = async (member, label, role) => {
    // Remove asks first; a role change is undone with the same select.
    if (role === 'revoked' && !window.confirm(removeCopy(label))) return
    setBusy(true)
    setError(null)
    const result = await api(`/api/club/members/${encodeURIComponent(member.uid)}/role`, { method: 'POST', body: { role } })
    setBusy(false)
    if (!result.ok) {
      setError(ROLE_ERRORS[result.body?.error] || 'Could not change that role. Please try again.')
      return
    }
    trackEvent(role === 'revoked' ? 'club_access_revoked' : 'club_role_changed', {
      surface: 'web',
      club_id: roster?.club?.id ?? null,
      scope: 'member',
      role,
    })
    await load()
  }

  /** Block asks first; Unblock loses nothing, so it doesn't. */
  const handleBlock = async (uid, blocked, label) => {
    if (blocked && !window.confirm(blockCopy(label))) return
    setBusy(true)
    setError(null)
    const result = await api(`/api/club/members/${encodeURIComponent(uid)}/block`, { method: 'POST', body: { blocked } })
    setBusy(false)
    if (!result.ok) {
      setError(ROLE_ERRORS[result.body?.error] || 'Could not change that. Please try again.')
      return
    }
    trackEvent(blocked ? 'club_member_blocked' : 'club_member_unblocked', {
      surface: 'web',
      club_id: roster?.club?.id ?? null,
    })
    await load()
  }

  const handleName = async (uid, name) => {
    setBusy(true)
    setError(null)
    const result = await api(`/api/club/members/${encodeURIComponent(uid)}/name`, { method: 'POST', body: { name } })
    setBusy(false)
    if (!result.ok) {
      setError('Could not save that name. Please try again.')
      return
    }
    await load()
  }

  const handlePortal = async () => {
    setBusy(true)
    setError(null)
    trackEvent('billing_portal_opened', { source: 'club_admin' })
    const result = await api('/api/billing/portal', { method: 'POST' })
    setBusy(false)
    if (!result.ok || !result.body?.url) {
      setError(
        result.status === 404
          ? 'This club was bought under a different Zoom account. Sign in as whoever paid to manage billing.'
          : 'Could not open the billing page. Please try again.'
      )
      return
    }
    window.location.assign(result.body.url)
  }

  const handleSignOut = async () => {
    await api('/api/club/manage/signout', { method: 'POST' }).catch(() => {})
    window.location.assign('/club/admin')
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      <header className="border-b border-white/10 bg-black/25 backdrop-blur-md">
        <div className="mx-auto flex max-w-4xl items-center gap-3 px-4 py-4">
          <Link to="/" className="flex items-center gap-3 text-white no-underline">
            <img src="/Toastmasters-Timer-logo.jpg" alt="Toastmusters Timer" className="h-10 w-10 rounded-xl object-cover shadow-sm ring-1 ring-white/20" />
            <h1 className="text-xl font-semibold">Toastmusters Timer</h1>
          </Link>
          <Link to="/account" className="ml-auto text-sm text-gray-300 hover:text-white">Your account</Link>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-12">
        {phase === 'loading' && <p className="text-gray-300">Loading your club…</p>}

        {phase === 'error' && <p className="text-red-300" role="alert">{error}</p>}

        {phase === 'doors' && <DoorsPanel reason={reason} />}

        {phase === 'ready' && roster && (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <Users className="h-6 w-6 text-amber-300" />
              <h2 className="text-2xl font-bold">{roster.club?.name || 'Your club'}</h2>
              <span className="rounded-full bg-white/10 px-2 py-0.5 text-xs text-gray-300">
                {roster.counts?.people ?? 0} {roster.counts?.people === 1 ? 'person' : 'people'} ·{' '}
                {roster.counts?.placesUsed ?? 0} of {roster.counts?.placesTotal ?? 3} places used
              </span>
            </div>
            <p className="mt-2 text-sm text-gray-400">
              Club code <span className="font-mono tracking-widest text-amber-300">{roster.club?.code}</span> ·{' '}
              {roster.entitled ? 'Pro' : 'Not active'}
              {roster.actor?.type === 'billing' && ' · signed in through your billing address'}
            </p>

            {error && <p className="mt-4 text-sm text-red-300" role="alert">{error}</p>}

            <section className="mt-8 rounded-2xl border border-white/10 bg-black/30 px-6 py-6">
              <h3 className="text-sm uppercase tracking-wide text-gray-400">Who is in the club</h3>
              <p className="mt-1 text-xs text-gray-400">
                The code lets in up to {roster.counts?.placesTotal ?? 3} Zoom accounts besides the owner. Each has the
                club&apos;s Pro wherever they sign in.
              </p>
              <ul className="mt-3">
                {roster.members.map((member) => (
                  <MemberRow
                    key={member.uid}
                    member={member}
                    isYou={roster.actor?.type === 'zoom' && roster.actor.uid === member.uid}
                    busy={busy}
                    onRole={handleRole}
                    onBlock={(person, label) => handleBlock(person.uid, true, label)}
                    onName={handleName}
                  />
                ))}
              </ul>

              {roster.blocked?.length > 0 && (
                <div className="mt-6 border-t border-white/10 pt-4">
                  <p className="font-semibold text-white">Blocked</p>
                  <p className="mt-1 text-xs text-gray-400">
                    The code won&apos;t let these accounts in. Unblocking doesn&apos;t put them back; they can join
                    with the code again.
                  </p>
                  <ul className="mt-2 space-y-1">
                    {roster.blocked.map((person) => {
                      const label = person.displayName || person.uid
                      return (
                        <li key={person.uid} className="flex items-center gap-3 text-sm">
                          <span
                            title={person.uid}
                            className={`text-gray-200 ${person.displayName ? '' : 'font-mono break-all'}`}
                          >
                            {label}
                          </span>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => handleBlock(person.uid, false, label)}
                            className="ml-auto text-xs text-gray-400 hover:text-gray-100 disabled:opacity-50"
                          >
                            Unblock
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )}
            </section>

            <section className="mt-6 rounded-2xl border border-white/10 bg-black/30 px-6 py-6">
              <h3 className="text-sm uppercase tracking-wide text-gray-400">Brand kit</h3>
              <div className="mt-3">
                <KitEditor
                  kit={roster.kit}
                  clubName={roster.club?.name}
                  onSaved={() => load()}
                />
              </div>
            </section>

            <section className="mt-6 rounded-2xl border border-white/10 bg-black/30 px-6 py-6">
              <h3 className="text-sm uppercase tracking-wide text-gray-400">Card set</h3>
              <ClubCards
                cards={roster.cards}
                clubName={roster.club?.name}
                onRemoved={() => {
                  load()
                  // This browser's account is usually in the club too; let it drop the set now.
                  refreshClub().catch(() => {})
                }}
              />
            </section>

            <section className="mt-6 rounded-2xl border border-white/10 bg-black/30 px-6 py-6">
              <h3 className="text-sm uppercase tracking-wide text-gray-400">Billing</h3>
              {roster.actor?.type === 'zoom' ? (
                <button
                  onClick={handlePortal}
                  disabled={busy}
                  className="mt-3 inline-flex items-center gap-2 rounded-lg bg-white/10 px-4 py-2 font-medium text-white hover:bg-white/20 disabled:opacity-60"
                >
                  <ExternalLink className="h-4 w-4" />
                  Manage billing
                </button>
              ) : (
                // The Stripe portal is opened against the buyer's own customer
                // record, which is keyed by their Zoom uid — so the way through
                // from here is to promote a current officer above and let them
                // sign in with Zoom.
                <p className="mt-3 text-sm text-gray-300">
                  Billing is managed by the Zoom account that paid. Promote a current officer to Admin above, then
                  have them sign in with Zoom to reach the billing page.
                </p>
              )}
              {roster.club?.billingEmail && (
                <p className="mt-3 flex items-center gap-2 text-xs text-gray-500">
                  <ShieldCheck className="h-3 w-3" />
                  Billing address on file: {roster.club.billingEmail}
                </p>
              )}
            </section>

            {roster.actor?.type === 'billing' && (
              <button
                onClick={handleSignOut}
                className="mt-6 inline-flex items-center gap-2 text-sm text-gray-400 hover:text-gray-100"
              >
                <LogOut className="h-4 w-4" />
                Sign out of this admin session
              </button>
            )}
          </>
        )}
      </main>
    </div>
  )
}
