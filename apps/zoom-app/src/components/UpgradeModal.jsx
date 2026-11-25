import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { X, Sparkles, ExternalLink, RefreshCw, Check, Users } from 'lucide-react';
import {
  waitForPro,
  refreshEntitlement,
  isPro as isProPlan,
  loadClub,
  activateClub,
  createClub,
  leaveClub,
  subscribeClub,
  lapsedClubName,
  markPromptAnswered,
  PRO_LAUNCH_PROMPT,
} from '@toastmaster-timer/shared';
import ClubSetupCard from '@toastmaster-timer/ui/ClubSetupCard';
import { trackEvent } from '../utils/posthog';
import { openExternalUrl, promptZoomAuthorize, readZoomUserSummary } from '../utils/zoomSdk';
import { getSessionToken, refreshZoomIdentity, resolveZoomIdentity } from '../utils/zoomIdentity';
import { clearPendingClubCode, readPendingClubCode, savePendingClubCode } from '../utils/pendingClubCode';
import { useEntitlement } from '../hooks/useEntitlement';
import { useFlag } from '../hooks/useFlag';
import { useLook } from '../b/LookContext';
import Sheet from '../b/Sheet';

/**
 * Buying Pro from inside Zoom, and joining a club that already bought it.
 *
 * Checkout is a Stripe-hosted page and Zoom's webview does not run payment
 * forms, so the purchase happens in the system browser. This modal starts it,
 * then waits: the Zoom side never sees Stripe's redirect, so it asks the Worker
 * every few seconds whether the plan has changed.
 *
 * The club code lives here rather than behind a surface of its own. There is no
 * first-launch prompt and no banner: a timer who was told "tap Upgrade, then
 * enter this code" finds the field where they were sent, and nothing stands
 * between anyone and the START button at the start of a meeting.
 *
 * Club Pro belongs to a Zoom account (#167), so the code field decides by
 * Zoom's sign-in status before anything is sent: signed out, it asks for a
 * Zoom sign-in; in guest mode (signed in, app not approved) it offers Zoom's
 * own Approve and keeps the typed code until the approval lands; authorized,
 * it sends the code with the session. Guests cannot buy either — there is no
 * identity to attach a purchase to — so they are pointed at adding the app.
 */

const PRICE_COPY = {
  monthly: { label: 'Monthly', hint: 'Cancel any time' },
  yearly: { label: 'Yearly', hint: 'Two months free' },
};

/**
 * A wrong code, a lapsed club and a blocked account all look the same on the
 * server, so they share one line; the refusals a person can act on name what
 * to do.
 */
const CLUB_ERRORS = {
  network: 'Could not reach the server. Check your connection and try again.',
  too_many_attempts: 'Too many tries. Wait a minute, then try again.',
};
const CLUB_ERROR_FALLBACK = "That code isn't active. Check with your club officer.";

function clubErrorFor(result) {
  if (result.error === 'full') {
    return `This club's Pro is full (${result.placesUsed ?? 3} of ${result.placesTotal ?? 3}). Ask the person who shared the code to free a place.`;
  }
  if (result.error === 'already_in_club') {
    return `You're already in ${result.clubName || 'another club'}. Leave it to join another club.`;
  }
  return CLUB_ERRORS[result.error] || CLUB_ERROR_FALLBACK;
}

/** What stands between this Zoom user and joining, before anything is sent. */
const SIGN_IN_COPY = 'Sign in to Zoom, then open the timer again to join your club.';
const APPROVE_COPY = 'Approve Toastmusters Timer in Zoom to join your club.';

/**
 * Whether this identity can send a code: null when it can (or when only the
 * server can tell), 'sign_in' when signed out of Zoom, 'approve' in guest mode.
 */
function joinGateFor(identity) {
  if (identity?.authStatus === 'unauthenticated') return 'sign_in';
  if (identity?.identified) return null;
  if (identity?.isGuest || identity?.authStatus === 'authenticated') return 'approve';
  return null;
}

/** How long the panel keeps watching for Zoom's approval, and how often. */
const APPROVAL_WATCH_MS = 2 * 60 * 1000;
const APPROVAL_POLL_MS = 2000;

const leaveCopy = (name) => `Leave ${name}? You'll lose its Pro on every computer where you're signed in.`;

/** Why leaving was refused. The owner never sees Leave, but the server says so too. */
const LEAVE_ERRORS = {
  last_admin: 'A club needs at least one admin. Promote somebody else first.',
  owner: 'The club’s owner can’t leave it. To end it, cancel the subscription.',
  network: 'Could not reach the server. Check your connection and try again.',
};
const LEAVE_ERROR_FALLBACK = 'Could not leave the club. Please try again.';

/** Setting up a club fails for reasons an officer can act on, so it names them. */
const CLUB_CREATE_ERRORS = {
  not_a_subscriber: 'Only the person who pays for the plan can set up the club.',
  no_billing_account:
    'We cannot find your payment yet. If you have just subscribed, give it a minute and try again.',
  creation_in_progress: 'Your club is already being set up. Give it a moment, then reopen this.',
  network: 'Could not reach the server. Check your connection and try again.',
};
const CLUB_CREATE_FALLBACK = 'Could not set up your club. Please try again.';

/** The cached club, as a React-readable store. */
function useClub() {
  return useSyncExternalStore(subscribeClub, loadClub, () => null);
}

async function startCheckout(interval, clubName) {
  const token = getSessionToken();
  if (!token) return { error: 'no_session' };
  const response = await fetch('/api/billing/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    // An empty name never blocks the purchase: the club is minted with a
    // generated placeholder and renaming is a one-field edit, whereas a buyer
    // stopped at a required field is a sale lost.
    body: JSON.stringify({ interval, ...(clubName.trim() ? { clubName: clubName.trim() } : {}) }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.url) return { error: body.error || `checkout_${response.status}` };
  return { url: body.url };
}

async function openPortal() {
  const token = getSessionToken();
  if (!token) return null;
  const response = await fetch('/api/billing/portal', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await response.json().catch(() => ({}));
  return response.ok ? body.url : null;
}

export default function UpgradeModal({ isOpen, onClose, source = 'unknown', onUpgraded }) {
  const { entitlement, isPro } = useEntitlement();
  const look = useLook();
  // Sounds join the pitch only once released; while `sounds` is off they are
  // locked as "coming soon" even for Pro.
  const { enabled: soundsReleased } = useFlag('sounds');
  const club = useClub();
  const [identity, setIdentity] = useState(null);
  const [phase, setPhase] = useState('choose'); // choose | opening | waiting | done | error
  const [checkoutUrl, setCheckoutUrl] = useState(null);
  const [error, setError] = useState(null);
  const [code, setCode] = useState('');
  const [clubBusy, setClubBusy] = useState(false);
  const [clubError, setClubError] = useState(null);
  // Signed out ('sign_in') or guest mode ('approve'): why a code was not sent.
  const [joinGate, setJoinGate] = useState(null);
  const [approving, setApproving] = useState(false);
  const [confirmingLeave, setConfirmingLeave] = useState(false);
  const [leaveBusy, setLeaveBusy] = useState(false);
  // Setting up the club has its own busy/error pair: it sits in the same modal
  // as joining one, and a failure in either must not mislabel the other.
  const [setupBusy, setSetupBusy] = useState(false);
  const [setupError, setSetupError] = useState(null);
  const [minted, setMinted] = useState(null);
  // What the buyer calls their club. Optional, and never a gate on checkout.
  const [clubNameInput, setClubNameInput] = useState('');
  const abortRef = useRef({ aborted: false });

  useEffect(() => {
    if (!isOpen) return undefined;
    // plan_source separates buyers from timers who activated a club code, which
    // is what the upgrade-funnel read needs to mean anything.
    trackEvent('upgrade_prompt_shown', { source, plan: entitlement.plan, plan_source: entitlement.source });
    // Whichever door they came through (footer, Sounds, Card Images, the
    // announcement itself), this user has now seen Pro: retire the one-time
    // announcement and the footer's "New" badge.
    markPromptAnswered(PRO_LAUNCH_PROMPT);
    // The renewal funnel's other end: a device that came looking after the
    // club's Pro stopped, which is the moment a renewal is most likely.
    const lapsed = lapsedClubName();
    if (lapsed) trackEvent('club_lapsed_shown', { surface: 'zoom', source, club_id: loadClub()?.club?.id ?? null });
    resolveZoomIdentity().then(setIdentity);
    setJoinGate(null);
    setConfirmingLeave(false);
    abortRef.current = { aborted: false };
    return () => {
      abortRef.current.aborted = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  useEffect(() => {
    if (isOpen && isPro && phase === 'waiting') {
      setPhase('done');
      trackEvent('checkout_completed', { source, club_id: club?.club?.id ?? null });
      onUpgraded?.();
    }
  }, [isOpen, isPro, phase, source, onUpgraded, club]);

  if (!isOpen) return null;

  const canBuy = Boolean(identity?.identified);

  const handleBuy = async (interval) => {
    setPhase('opening');
    setError(null);
    trackEvent('checkout_started', { source, interval, club_id: clubId, named_club: Boolean(clubNameInput.trim()) });

    const result = await startCheckout(interval, clubNameInput);
    if (result.error) {
      setError(
        result.error === 'Plan is not available'
          ? 'Plans are not set up yet. Please try again later.'
          : 'Could not start checkout. Please try again.'
      );
      setPhase('error');
      trackEvent('checkout_failed', { source, interval, reason: result.error, club_id: clubId });
      return;
    }

    setCheckoutUrl(result.url);
    const opened = await openExternalUrl(result.url);
    if (!opened) trackEvent('checkout_open_failed', { source, interval, club_id: clubId });
    setPhase('waiting');

    const becamePro = await waitForPro({ getToken: getSessionToken, signal: abortRef.current });
    if (!becamePro && !abortRef.current.aborted) {
      setPhase((current) => (current === 'waiting' ? 'error' : current));
      setError('We have not heard from Stripe yet. Use Refresh once you have paid.');
    }
  };

  const handleRefresh = async () => {
    const fresh = await refreshEntitlement({ getToken: getSessionToken });
    if (fresh && isProPlan(fresh)) return; // the effect above flips to done
    setError('Not active yet. Payments can take a minute to arrive.');
  };

  const handleManage = async () => {
    trackEvent('billing_portal_opened', { source });
    const url = await openPortal();
    if (!url || !(await openExternalUrl(url))) {
      setError('Could not open the billing page. Please try again.');
    }
  };

  /**
   * Send a code with the session. `via` says how it got here: typed, or the
   * code a guest typed before approving the app.
   */
  const sendCode = async (typed, who, via) => {
    setClubBusy(true);
    setClubError(null);
    const result = await activateClub(typed, { getToken: getSessionToken, uid: who?.uid ?? null });
    setClubBusy(false);

    if (!result.ok) {
      // A session-less request that slipped through says the same as the
      // client would have.
      if (result.error === 'sign_in_required') setJoinGate('sign_in');
      else setClubError(clubErrorFor(result));
      trackEvent('club_code_rejected', { surface: 'zoom', source, reason: result.error });
      return result;
    }

    setCode('');
    setJoinGate(null);
    trackEvent('club_code_activated', {
      surface: 'zoom',
      source,
      club_id: result.club.club?.id ?? null,
      places_used: result.placesUsed,
      via,
    });
    onUpgraded?.();
    return result;
  };

  const handleActivate = async (event) => {
    event?.preventDefault?.();
    const typed = code.trim();
    if (clubBusy || !typed) return;
    setClubError(null);

    const who = identity ?? (await resolveZoomIdentity());
    const gate = joinGateFor(who);
    if (gate) {
      setJoinGate(gate);
      // Kept so the approval, not a second round of typing, is the next step.
      if (gate === 'approve') savePendingClubCode(typed);
      trackEvent('club_code_rejected', {
        surface: 'zoom',
        source,
        reason: gate === 'approve' ? 'approve_required' : 'sign_in_required',
      });
      return;
    }
    setJoinGate(null);
    await sendCode(typed, who, 'typed');
  };

  /** Once the identity resolves as authorized, the waiting code goes out. */
  const sendPendingIfApproved = async (fresh) => {
    setIdentity(fresh);
    const pending = readPendingClubCode();
    if (!pending || !fresh?.identified || fresh.authStatus !== 'authorized') return false;
    const result = await sendCode(pending, fresh, 'approved');
    if (result.ok || result.error !== 'network') clearPendingClubCode();
    return true;
  };

  /**
   * Zoom's own approve prompt, then the code. The prompt settles when it has
   * been shown, not when it has been answered, so the panel watches Zoom's
   * status for a while; an approval it misses is picked up on the next open.
   */
  const handleApprove = async () => {
    if (approving) return;
    setApproving(true);
    await promptZoomAuthorize();
    if (await sendPendingIfApproved(await refreshZoomIdentity())) {
      setApproving(false);
      return;
    }
    const watch = abortRef.current;
    const deadline = Date.now() + APPROVAL_WATCH_MS;
    while (!watch.aborted && Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, APPROVAL_POLL_MS));
      if (watch.aborted) break;
      // eslint-disable-next-line no-await-in-loop
      const summary = await readZoomUserSummary();
      if (summary?.status !== 'authorized') continue;
      // eslint-disable-next-line no-await-in-loop
      await sendPendingIfApproved(await refreshZoomIdentity());
      break;
    }
    if (!watch.aborted) setApproving(false);
  };

  const handleLeave = async () => {
    const clubId = club?.club?.id ?? null;
    setConfirmingLeave(false);
    setLeaveBusy(true);
    const result = await leaveClub({ getToken: getSessionToken });
    setLeaveBusy(false);
    if (!result.ok) {
      setClubError(LEAVE_ERRORS[result.error] || LEAVE_ERROR_FALLBACK);
      return;
    }
    setClubError(null);
    trackEvent('club_left', { surface: 'zoom', source, club_id: clubId });
  };

  const handleCreateClub = async (name) => {
    setSetupBusy(true);
    setSetupError(null);
    const result = await createClub({ clubName: name }, { getToken: getSessionToken });
    setSetupBusy(false);

    if (!result.ok) {
      setSetupError(CLUB_CREATE_ERRORS[result.error] || CLUB_CREATE_FALLBACK);
      trackEvent('club_create_failed', { surface: 'zoom', source, reason: result.error });
      return;
    }

    setMinted({ code: result.code, shareUrl: result.shareUrl });
    trackEvent('club_created', {
      surface: 'zoom',
      source: 'self_serve',
      club_id: result.club.club?.id ?? null,
      created: result.created,
    });
    onUpgraded?.();
  };

  // The console is a web page — an officer reading a roster is not in a meeting
  // — so from here it opens in the system browser, the same way Checkout does.
  const handleManageClub = async (adminUrl) => {
    trackEvent('club_admin_opened', { surface: 'zoom', via: 'upgrade_modal' });
    if (!(await openExternalUrl(adminUrl))) {
      setSetupError('Could not open your browser. Open the timer’s web site and go to Manage your club.');
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(checkoutUrl);
      setError(null);
    } catch {
      setError('Copy failed. Select the link and copy it yourself.');
    }
  };

  const clubName = club?.club?.name || 'your club';
  const clubActive = Boolean(club?.entitled);
  const clubId = club?.club?.id ?? null;

  // The gap this closes: a buyer inside Zoom had no way to learn their club
  // code, and no way to reach the console — both lived on one browser-only
  // page. Admin-of-a-club rather than device-has-a-club, so a subscriber who
  // joined someone else's club can still set up their own.
  const isClubAdmin = club?.role === 'admin';
  const canCreateClub = isPro && entitlement.source === 'subscription' && !isClubAdmin;
  const shareCode = minted?.code ?? (isClubAdmin ? club?.code ?? null : null);
  const shareUrl = minted?.shareUrl ?? (isClubAdmin ? club?.shareUrl ?? null : null);
  // Built off the share link rather than window.location: inside Zoom this app
  // is served from zoom.<domain>, and that host routes every path back to this
  // app. The share link carries the Worker's WEB_ORIGIN, which is the web app.
  const adminUrl = shareUrl ? new URL('/club/admin', shareUrl).toString() : null;

  const renderClubSetup = () => {
    if (!shareCode && !canCreateClub) return null;
    return (
      <div className="mt-4 pt-4 border-t border-gray-200">
        <ClubSetupCard
          tone="light"
          code={shareCode}
          shareUrl={shareUrl}
          busy={setupBusy}
          error={setupError}
          placesUsed={isClubAdmin ? club?.placesUsed ?? null : null}
          placesTotal={isClubAdmin ? club?.placesTotal ?? null : null}
          onCreate={handleCreateClub}
          onCopied={(what) => trackEvent('club_invite_copied', { surface: 'zoom', what })}
          onManageClub={adminUrl ? () => handleManageClub(adminUrl) : undefined}
        />
      </div>
    );
  };
  // A club that lapsed is not a club that was never joined: the device still
  // knows which one to check, so the modal names it rather than pretending the
  // last six months did not happen.
  const lapsedClub = lapsedClubName();

  /**
   * The code field. Below the prices rather than above them: a buyer is the
   * common case at this point, and a timer who was told where to type arrives
   * knowing what they are looking for.
   */
  const renderCodeEntry = () => (
    <form onSubmit={handleActivate} className="mt-4 pt-4 border-t border-gray-200">
      <label htmlFor="club-code" className="block text-sm font-medium text-gray-700">
        Already on Pro with your club?
      </label>
      <p className="text-xs text-gray-500 mt-0.5 mb-2">
        Enter the code your club officer shared. It joins the Zoom account you&apos;re signed in with.
      </p>
      <div className="flex gap-2">
        <input
          id="club-code"
          aria-label="Already on Pro through your club? Enter its code"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          placeholder="DTSP-7K2QM9"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm uppercase tracking-wide"
        />
        <button
          type="submit"
          disabled={clubBusy || !code.trim()}
          className="px-4 py-2 bg-gray-800 hover:bg-gray-900 disabled:opacity-50 text-white font-semibold rounded-lg transition-colors text-sm"
        >
          {clubBusy ? 'Checking…' : 'Activate'}
        </button>
      </div>
      {clubError && <p className="text-xs text-red-600 mt-2" role="alert">{clubError}</p>}
      {joinGate === 'sign_in' && <p className="text-xs text-gray-700 mt-2">{SIGN_IN_COPY}</p>}
      {joinGate === 'approve' && (
        <div className="mt-2 flex items-center gap-2">
          <p className="flex-1 text-xs text-gray-700">{APPROVE_COPY}</p>
          <button
            type="button"
            onClick={handleApprove}
            disabled={approving}
            className="px-3 py-1.5 bg-blue-500 hover:bg-blue-600 disabled:opacity-60 text-white font-semibold rounded-lg transition-colors text-xs"
          >
            Approve
          </button>
        </div>
      )}
    </form>
  );

  const renderBody = () => {
    // A club device sees its club, not a price list — whichever way it got here.
    if (clubActive && phase !== 'done') {
      return (
        <>
          <div className="flex items-start gap-2 mb-3">
            <Users className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-gray-700">
              You&apos;re on <span className="font-semibold">Pro</span> through{' '}
              <span className="font-semibold">{clubName}</span>.
            </p>
          </div>
          <ul className="text-sm text-gray-600 space-y-1.5 mb-4">
            <li className="flex gap-2"><Check className="w-4 h-4 text-green-600 flex-shrink-0 mt-0.5" /> Your club&apos;s shared timing presets</li>
            <li className="flex gap-2"><Check className="w-4 h-4 text-green-600 flex-shrink-0 mt-0.5" /> Your club&apos;s branding on cards and reports</li>
            {identity?.identified && (
              <li className="flex gap-2"><Check className="w-4 h-4 text-green-600 flex-shrink-0 mt-0.5" /> Your own settings and artwork follow you between devices</li>
            )}
          </ul>
          {entitlement.source === 'subscription' && (
            <button
              onClick={handleManage}
              className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-800 font-semibold rounded-lg transition-colors text-sm mb-2"
            >
              <ExternalLink className="w-4 h-4" />
              Manage billing
            </button>
          )}
          {error && <p className="text-xs text-red-600 mb-2">{error}</p>}
          {clubError && <p className="text-xs text-red-600 mb-2" role="alert">{clubError}</p>}
          {/* Leaving is by account, on every computer it is signed in on, so it
              asks first. The owner pays for the club and ends it by cancelling,
              so they are never offered it. Their own presets and artwork were
              never written over, so leaving cannot take them away. */}
          {!club?.isOwner && !confirmingLeave && (
            <button
              onClick={() => setConfirmingLeave(true)}
              disabled={leaveBusy}
              className="w-full px-4 py-2 text-gray-500 hover:text-gray-700 text-xs"
            >
              Leave {clubName}
            </button>
          )}
          {!club?.isOwner && confirmingLeave && (
            <div role="alertdialog" aria-label={`Leave ${clubName}`} className="rounded-lg border border-gray-200 bg-gray-50 p-3">
              <p className="text-sm text-gray-700">{leaveCopy(clubName)}</p>
              <div className="mt-3 flex justify-end gap-2">
                <button
                  onClick={() => setConfirmingLeave(false)}
                  className="px-3 py-1.5 bg-gray-200 hover:bg-gray-300 text-gray-800 font-semibold rounded-lg text-xs"
                >
                  Cancel
                </button>
                <button
                  onClick={handleLeave}
                  className="px-3 py-1.5 bg-red-500 hover:bg-red-600 text-white font-semibold rounded-lg text-xs"
                >
                  Leave
                </button>
              </div>
            </div>
          )}
          {/* An admin's code and invite link, on the surface they already use. */}
          {renderClubSetup()}
        </>
      );
    }

    if (isPro && phase !== 'done') {
      return (
        <>
          <p className="text-sm text-gray-600 mb-4">
            You are on <span className="font-semibold">Pro</span>. Your settings and card artwork
            follow you to every device you run the meeting from.
            {entitlement.cancelAtPeriodEnd && entitlement.currentPeriodEnd && (
              <> Your plan ends on {new Date(entitlement.currentPeriodEnd).toLocaleDateString()}.</>
            )}
          </p>
          <button
            onClick={handleManage}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-800 font-semibold rounded-lg transition-colors text-sm"
          >
            <ExternalLink className="w-4 h-4" />
            Manage billing
          </button>
          {/* The subscriber who has never set up a club: the reason a paying
              user could reach none of the features they are paying for. */}
          {renderClubSetup()}
        </>
      );
    }

    if (phase === 'done') {
      return (
        <div className="text-center py-2">
          <div className="mx-auto w-12 h-12 rounded-full bg-green-100 flex items-center justify-center mb-3">
            <Check className="w-6 h-6 text-green-600" />
          </div>
          <p className="text-sm text-gray-700 font-medium">You&apos;re on Pro. Thank you!</p>
          <p className="text-xs text-gray-500 mt-1">Your settings will start syncing right away.</p>
          {/* The moment the buyer is most willing to finish setting up. The
              webhook has usually minted the club already, and the endpoint is
              idempotent — so this puts this device on it and shows the code. */}
          <div className="text-left">{renderClubSetup()}</div>
        </div>
      );
    }

    if (phase === 'waiting' || phase === 'error') {
      return (
        <>
          <p className="text-sm text-gray-600 mb-3">
            {phase === 'waiting' ? 'Finish the purchase in your browser.' : 'Waiting for your purchase.'}{' '}
            This window updates on its own once Stripe confirms it, which can take a minute.
          </p>
          {checkoutUrl && (
            <div className="mb-3">
              <p className="text-xs text-gray-500 mb-1">Browser did not open? Use this link:</p>
              <div className="flex gap-2">
                <input
                  readOnly
                  value={checkoutUrl}
                  onFocus={(e) => e.target.select()}
                  className="flex-1 text-xs px-2 py-1.5 border border-gray-300 rounded-md bg-gray-50 text-gray-700"
                  aria-label="Checkout link"
                />
                <button
                  onClick={copyLink}
                  className="px-3 py-1.5 text-xs bg-gray-100 hover:bg-gray-200 rounded-md text-gray-800"
                >
                  Copy
                </button>
              </div>
            </div>
          )}
          {error && <p className="text-xs text-amber-700 mb-3">{error}</p>}
          <button
            onClick={handleRefresh}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white font-semibold rounded-lg transition-colors text-sm"
          >
            <RefreshCw className="w-4 h-4" />
            I have paid, refresh
          </button>
        </>
      );
    }

    // A guest cannot buy — there is no identity to attach a purchase to. The
    // code field stays: it walks them through signing in or approving the app.
    if (identity && !canBuy) {
      return (
        <>
          <p className="text-sm text-gray-600">
            To subscribe, sign in to Zoom and add Toastmasters Timer from the Zoom App Marketplace.
            Pro needs to know it is you so your settings can follow you between devices.
          </p>
        </>
      );
    }

    return (
      <>
        {/* The pitch is the club, not personal sync. A treasurer who is not the
            person timing has to see what the whole club gets, in the order the
            club would rank it — the buyer's own sync is the fourth line, not
            the first. */}
        {lapsedClub && (
          <p className="text-sm text-gray-700 mb-3">
            <span className="font-semibold">{lapsedClub}&apos;s Pro has ended.</span>{' '}
            Nothing was deleted — renew and every device gets its presets, branding and
            archive back with nothing re-entered.
          </p>
        )}
        <ul className="text-sm text-gray-700 space-y-1.5 mb-4">
          <li className="flex gap-2"><Check className="w-4 h-4 text-green-600 flex-shrink-0 mt-0.5" /> Your club&apos;s brand kit on every timer card and report</li>
          <li className="flex gap-2"><Check className="w-4 h-4 text-green-600 flex-shrink-0 mt-0.5" /> Shared timing presets — set once, every timer gets them</li>
          <li className="flex gap-2"><Check className="w-4 h-4 text-green-600 flex-shrink-0 mt-0.5" /> Every meeting saved to your club&apos;s archive</li>
          {soundsReleased && (
            <li className="flex gap-2"><Check className="w-4 h-4 text-green-600 flex-shrink-0 mt-0.5" /> A chime when the card changes, and music during breaks</li>
          )}
          <li className="flex gap-2"><Check className="w-4 h-4 text-green-600 flex-shrink-0 mt-0.5" /> Your settings backed up and synced across devices</li>
          <li className="flex gap-2"><Check className="w-4 h-4 text-green-600 flex-shrink-0 mt-0.5" /> The timer itself stays free, always</li>
        </ul>
        {/* Optional, and deliberately so: payment is the one moment this name
            naturally exists, but a buyer stopped at a required field is a sale
            lost. Empty mints "Club 7K2QM9", which an officer can rename. */}
        <label htmlFor="club-name" className="block text-sm font-medium text-gray-700">
          Your club&apos;s name <span className="font-normal text-gray-400">(optional)</span>
        </label>
        <input
          id="club-name"
          value={clubNameInput}
          onChange={(event) => setClubNameInput(event.target.value)}
          placeholder="Downtown Speakers"
          maxLength={80}
          className="mt-1 mb-4 w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
        />
        {error && <p className="text-xs text-red-600 mb-3">{error}</p>}
        <div className="grid grid-cols-2 gap-2">
          {Object.entries(PRICE_COPY).map(([interval, copy]) => (
            <button
              key={interval}
              onClick={() => handleBuy(interval)}
              disabled={phase === 'opening' || !identity}
              className="flex flex-col items-center px-3 py-2.5 bg-blue-500 hover:bg-blue-600 disabled:opacity-60 text-white rounded-lg transition-colors"
            >
              <span className="font-semibold text-sm">{copy.label}</span>
              <span className="text-xs opacity-90">{copy.hint}</span>
            </button>
          ))}
        </div>
        <p className="text-xs text-gray-400 mt-3 text-center">
          Opens a secure Stripe page in your browser. Prices are shown there.
        </p>
      </>
    );
  };

  const title = isPro || phase === 'done' ? 'Toastmasters Timer Pro' : 'One Pro account for your whole club';

  // Under the price list, for buyers and guests alike. Rendered beside the body
  // rather than inside each branch, so the field a person is typing into is
  // the same element when the identity resolves and the body above it changes.
  const codeEntry = !clubActive && !isPro && (phase === 'choose' || phase === 'opening') ? renderCodeEntry() : null;

  // Design B (plan 13) opens every setting as a sheet from the bottom edge.
  if (look === 'b') {
    return (
      <Sheet
        open
        onClose={onClose}
        title={title}
        badge={<span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-bold text-amber-800">PRO</span>}
      >
        {renderBody()}
        {codeEntry}
      </Sheet>
    );
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg p-6 w-full max-w-md">
        <div className="flex justify-between items-start mb-4">
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-amber-500" />
            {/* The pitch that passes the 30-second test: a treasurer who never
                times a meeting has to see what their whole club gets, not what
                one laptop gets. */}
            {title}
          </h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 flex-shrink-0"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        {renderBody()}
        {codeEntry}
      </div>
    </div>
  );
}
