import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { X, Sparkles, ExternalLink, RefreshCw, Check, Users } from 'lucide-react';
import {
  waitForPro,
  refreshEntitlement,
  isPro as isProPlan,
  loadClub,
  activateClub,
  leaveClub,
  subscribeClub,
} from '@toastmaster-timer/shared';
import { trackEvent } from '../utils/posthog';
import { openExternalUrl } from '../utils/zoomSdk';
import { getSessionToken, resolveZoomIdentity } from '../utils/zoomIdentity';
import { useEntitlement } from '../hooks/useEntitlement';

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
 * Guests (not signed in to Zoom, or the app not added) have no identity to
 * attach a purchase to, so they are pointed at adding the app first — but the
 * code field works for them, which is the whole point of it.
 */

const PRICE_COPY = {
  monthly: { label: 'Monthly', hint: 'Cancel any time' },
  yearly: { label: 'Yearly', hint: 'Two months free' },
};

/** Every rejection looks the same on the server, so there is one line to show. */
const CLUB_ERRORS = {
  network: 'Could not reach the server. Check your connection and try again.',
  too_many_attempts: 'Too many tries. Wait a minute, then try again.',
};
const CLUB_ERROR_FALLBACK = "That code isn't active. Check with your club officer.";

/** The cached club, as a React-readable store. */
function useClub() {
  return useSyncExternalStore(subscribeClub, loadClub, () => null);
}

async function startCheckout(interval) {
  const token = getSessionToken();
  if (!token) return { error: 'no_session' };
  const response = await fetch('/api/billing/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ interval }),
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
  const club = useClub();
  const [identity, setIdentity] = useState(null);
  const [phase, setPhase] = useState('choose'); // choose | opening | waiting | done | error
  const [checkoutUrl, setCheckoutUrl] = useState(null);
  const [error, setError] = useState(null);
  const [code, setCode] = useState('');
  const [clubBusy, setClubBusy] = useState(false);
  const [clubError, setClubError] = useState(null);
  const abortRef = useRef({ aborted: false });

  useEffect(() => {
    if (!isOpen) return undefined;
    // plan_source separates buyers from timers who activated a club code, which
    // is what the upgrade-funnel read needs to mean anything.
    trackEvent('upgrade_prompt_shown', { source, plan: entitlement.plan, plan_source: entitlement.source });
    resolveZoomIdentity().then(setIdentity);
    abortRef.current = { aborted: false };
    return () => {
      abortRef.current.aborted = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  useEffect(() => {
    if (isOpen && isPro && phase === 'waiting') {
      setPhase('done');
      trackEvent('checkout_completed', { source });
      onUpgraded?.();
    }
  }, [isOpen, isPro, phase, source, onUpgraded]);

  if (!isOpen) return null;

  const canBuy = Boolean(identity?.identified);

  const handleBuy = async (interval) => {
    setPhase('opening');
    setError(null);
    trackEvent('checkout_started', { source, interval });

    const result = await startCheckout(interval);
    if (result.error) {
      setError(
        result.error === 'Plan is not available'
          ? 'Plans are not set up yet. Please try again later.'
          : 'Could not start checkout. Please try again.'
      );
      setPhase('error');
      trackEvent('checkout_failed', { source, interval, reason: result.error });
      return;
    }

    setCheckoutUrl(result.url);
    const opened = await openExternalUrl(result.url);
    if (!opened) trackEvent('checkout_open_failed', { source, interval });
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

  const handleActivate = async (event) => {
    event?.preventDefault?.();
    if (clubBusy || !code.trim()) return;
    setClubBusy(true);
    setClubError(null);

    const result = await activateClub(code, { getToken: getSessionToken });
    setClubBusy(false);

    if (!result.ok) {
      setClubError(CLUB_ERRORS[result.error] || CLUB_ERROR_FALLBACK);
      trackEvent('club_code_rejected', { surface: 'zoom', source, reason: result.error });
      return;
    }

    setCode('');
    trackEvent('club_code_activated', {
      surface: 'zoom',
      source,
      club_id: result.club.club?.id ?? null,
      is_guest: !identity?.identified,
      via: 'typed',
    });
    onUpgraded?.();
  };

  const handleLeave = () => {
    const clubId = club?.club?.id ?? null;
    leaveClub();
    setClubError(null);
    trackEvent('club_left', { surface: 'zoom', source, club_id: clubId });
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

  /**
   * The code field. Below the prices rather than above them: a buyer is the
   * common case at this point, and a timer who was told where to type arrives
   * knowing what they are looking for.
   */
  const renderCodeEntry = () => (
    <form onSubmit={handleActivate} className="mt-4 pt-4 border-t border-gray-200">
      <label htmlFor="club-code" className="block text-sm font-medium text-gray-700">
        Already on Pro through your club?
      </label>
      <p className="text-xs text-gray-500 mt-0.5 mb-2">
        Enter the code your club officer shared. No sign-in needed.
      </p>
      <div className="flex gap-2">
        <input
          id="club-code"
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
              This device is on <span className="font-semibold">Pro</span> through{' '}
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
          {/* A deletion, not a restore: this device's own presets and artwork
              were never written over, so leaving cannot take them away. */}
          <button
            onClick={handleLeave}
            className="w-full px-4 py-2 text-gray-500 hover:text-gray-700 text-xs"
          >
            Leave this club on this device
          </button>
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

    // A guest cannot buy — there is no identity to attach a purchase to — but a
    // club code needs no identity at all, so the field stays.
    if (identity && !canBuy) {
      return (
        <>
          <p className="text-sm text-gray-600">
            To subscribe, sign in to Zoom and add Toastmasters Timer from the Zoom App Marketplace.
            Pro needs to know it is you so your settings can follow you between devices.
          </p>
          {renderCodeEntry()}
        </>
      );
    }

    return (
      <>
        <ul className="text-sm text-gray-700 space-y-1.5 mb-4">
          <li className="flex gap-2"><Check className="w-4 h-4 text-green-600 flex-shrink-0 mt-0.5" /> Timing rules, roles and agenda follow you to every computer</li>
          <li className="flex gap-2"><Check className="w-4 h-4 text-green-600 flex-shrink-0 mt-0.5" /> Custom card artwork backed up and synced</li>
          <li className="flex gap-2"><Check className="w-4 h-4 text-green-600 flex-shrink-0 mt-0.5" /> The timer itself stays free, always</li>
        </ul>
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
        {renderCodeEntry()}
      </>
    );
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg p-6 w-full max-w-md">
        <div className="flex justify-between items-start mb-4">
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-amber-500" />
            {/* The reframed "One Pro account for your whole club" pitch lands
                with the club-name field in Phase 7; the code field is what
                Phase 1 owes a timer who was told where to type. */}
            {isPro || phase === 'done' ? 'Toastmasters Timer Pro' : 'Take your setup everywhere'}
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
      </div>
    </div>
  );
}
