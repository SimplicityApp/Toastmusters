import { useState } from 'react';

/**
 * Minting the club a subscription pays for, and handing over the code.
 *
 * The club is the unit of Pro, so a subscriber without one can reach none of
 * the features they are paying for. Until this existed the only way to get a
 * club was to name it at checkout and wait for an operator, which left every
 * earlier subscriber — and everyone who skipped the optional field — stuck.
 *
 * Shared by both apps rather than written twice, because "where do I set up my
 * club" having a different answer in Zoom than in the browser is the problem
 * this is here to fix. Zoom is the main distribution channel: a member who
 * never visits the web site must still be able to do this.
 *
 * The second state matters as much as the first. A code nobody can read is a
 * club nobody can join, and before this the code was rendered in exactly one
 * place in the whole product — a browser-only admin page. So creation ends by
 * showing the code *and* the link that carries it, both copyable.
 *
 * Stock Tailwind and inline SVG only — see README.md.
 *
 * @param {Object} props
 * @param {'light'|'dark'} [props.tone] - light for the Zoom sidebar, dark for the web
 * @param {string|null} [props.code] - shown instead of the form once there is one
 * @param {string|null} [props.shareUrl] - the officer's /pro/<code> link
 * @param {string} [props.defaultName] - prefill, e.g. what checkout recorded
 * @param {boolean} [props.busy]
 * @param {string|null} [props.error]
 * @param {(name: string) => void} [props.onCreate]
 * @param {(what: 'code'|'link') => void} [props.onCopied]
 * @param {() => void} [props.onManageClub] - opens the officer's console
 */

const STROKE = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': 'true',
};

const TONES = {
  light: {
    heading: 'text-gray-900',
    body: 'text-gray-600',
    label: 'text-gray-700',
    input: 'border-gray-300 bg-white text-gray-900 placeholder-gray-400',
    primary: 'bg-blue-500 hover:bg-blue-600 text-white',
    secondary: 'bg-gray-100 hover:bg-gray-200 text-gray-800',
    codeBox: 'border-gray-200 bg-gray-50 text-gray-900',
    error: 'text-red-600',
    muted: 'text-gray-500',
  },
  dark: {
    heading: 'text-white',
    body: 'text-gray-300',
    label: 'text-gray-200',
    input: 'border-white/20 bg-black/30 text-white placeholder-gray-500',
    primary: 'bg-white hover:bg-gray-100 text-gray-900',
    secondary: 'bg-white/10 hover:bg-white/20 text-white',
    codeBox: 'border-white/10 bg-black/30 text-white',
    error: 'text-red-300',
    muted: 'text-gray-400',
  },
};

function UsersMark({ className }) {
  return (
    <svg {...STROKE} className={className}>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

/** One copyable value. The confirmation is the button's own label. */
function CopyRow({ label, value, tone, onCopy }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      onCopy?.();
    } catch {
      // Clipboard refused (permissions, insecure context). The value is on
      // screen and selectable, so there is nothing to recover from.
    }
  };

  return (
    <div className="mt-3">
      <p className={`text-xs ${tone.muted}`}>{label}</p>
      <div className="mt-1 flex gap-2">
        <input
          readOnly
          value={value}
          onFocus={(event) => event.target.select()}
          aria-label={label}
          className={`min-w-0 flex-1 rounded-md border px-2 py-1.5 text-sm ${tone.codeBox}`}
        />
        <button
          type="button"
          onClick={copy}
          className={`flex-shrink-0 rounded-md px-3 py-1.5 text-xs font-medium ${tone.secondary}`}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

export default function ClubSetupCard({
  tone = 'light',
  code = null,
  shareUrl = null,
  defaultName = '',
  busy = false,
  error = null,
  onCreate,
  onCopied,
  onManageClub,
}) {
  const t = TONES[tone] ?? TONES.light;
  const [name, setName] = useState(defaultName);

  if (code) {
    return (
      <div>
        <div className="flex items-start gap-2">
          <UsersMark className={`mt-0.5 h-5 w-5 flex-shrink-0 ${t.heading}`} />
          <p className={`text-sm ${t.body}`}>
            Your club is set up. Share the code — or the link, which activates Pro on its own —
            and everyone who times a meeting gets your presets, branding and archive.
          </p>
        </div>

        <CopyRow label="Club code" value={code} tone={t} onCopy={() => onCopied?.('code')} />
        {shareUrl && (
          <CopyRow label="Invite link" value={shareUrl} tone={t} onCopy={() => onCopied?.('link')} />
        )}

        {/* In Zoom this opens the system browser: an officer reading a roster is
            not in a meeting, so the console stays a web page. */}
        {onManageClub && (
          <button
            type="button"
            onClick={onManageClub}
            className={`mt-4 inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold ${t.secondary}`}
          >
            <svg {...STROKE} className="h-4 w-4">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <path d="M15 3h6v6M10 14 21 3" />
            </svg>
            Manage your club
          </button>
        )}
      </div>
    );
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy) onCreate?.(name);
      }}
    >
      <div className="flex items-start gap-2">
        <UsersMark className={`mt-0.5 h-5 w-5 flex-shrink-0 ${t.heading}`} />
        <p className={`text-sm ${t.body}`}>
          Your plan covers your whole club. Set it up to get a code your members can enter — then
          your presets, branding and meeting archive follow every device that uses it.
        </p>
      </div>

      <label htmlFor="setup-club-name" className={`mt-4 block text-sm font-medium ${t.label}`}>
        Your club&apos;s name <span className={`font-normal ${t.muted}`}>(optional)</span>
      </label>
      <input
        id="setup-club-name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="Downtown Speakers"
        maxLength={80}
        className={`mt-1 w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 ${t.input}`}
      />

      {error && <p className={`mt-3 text-sm ${t.error}`} role="alert">{error}</p>}

      {/* Never a gate: an empty name mints a club named after its own code, and
          renaming is a one-field edit in the console. */}
      <button
        type="submit"
        disabled={busy}
        className={`mt-4 w-full rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-60 ${t.primary}`}
      >
        {busy ? 'Setting up…' : 'Set up my club'}
      </button>
    </form>
  );
}
