import { useEffect, useRef, useState } from 'react';
import { X, Sparkles, ExternalLink, RefreshCw, Check } from 'lucide-react';
import { waitForPro, refreshEntitlement, isPro as isProPlan } from '@toastmaster-timer/shared';
import { trackEvent } from '../utils/posthog';
import { openExternalUrl } from '../utils/zoomSdk';
import { getSessionToken, resolveZoomIdentity } from '../utils/zoomIdentity';
import { useEntitlement } from '../hooks/useEntitlement';

/**
 * Buying Pro from inside Zoom.
 *
 * Checkout is a Stripe-hosted page and Zoom's webview does not run payment
 * forms, so the purchase happens in the system browser. This modal starts it,
 * then waits: the Zoom side never sees Stripe's redirect, so it asks the Worker
 * every few seconds whether the plan has changed.
 *
 * Guests (not signed in to Zoom, or the app not added) have no identity to
 * attach a purchase to, so they are pointed at adding the app first.
 */

const PRICE_COPY = {
  monthly: { label: 'Monthly', hint: 'Cancel any time' },
  yearly: { label: 'Yearly', hint: 'Two months free' },
};

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
  const [identity, setIdentity] = useState(null);
  const [phase, setPhase] = useState('choose'); // choose | opening | waiting | done | error
  const [checkoutUrl, setCheckoutUrl] = useState(null);
  const [error, setError] = useState(null);
  const abortRef = useRef({ aborted: false });

  useEffect(() => {
    if (!isOpen) return undefined;
    trackEvent('upgrade_prompt_shown', { source, plan: entitlement.plan });
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

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(checkoutUrl);
      setError(null);
    } catch {
      setError('Copy failed. Select the link and copy it yourself.');
    }
  };

  const renderBody = () => {
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

    if (identity && !canBuy) {
      return (
        <p className="text-sm text-gray-600">
          To subscribe, sign in to Zoom and add Toastmasters Timer from the Zoom App Marketplace.
          Pro needs to know it is you so your settings can follow you between devices.
        </p>
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
      </>
    );
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg p-6 w-full max-w-md">
        <div className="flex justify-between items-start mb-4">
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-amber-500" />
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
