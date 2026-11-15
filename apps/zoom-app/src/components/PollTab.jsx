import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Lock, Plus, Trash2, X } from 'lucide-react';
import {
  BREAK_ROLE,
  DEFAULT_CUSTOM_RULES,
  activePollTemplate,
  ballotFromTemplate,
  canPublishPresets,
  categoryTitle,
  clubHeaders,
  clubPresetsLive,
  closedPollResult,
  ensureForked,
  loadClub,
  loadPollDraft,
  publishPollTemplate,
  recordPollResults,
  savePollDraft,
  savePollResult,
  savePollTemplate,
  setStageWinners,
} from '@toastmaster-timer/shared';
import { useTimer } from '../context/TimerContext';
import { useToast } from '../context/ToastContext';
import { useEntitlement } from '../hooks/useEntitlement';
import { useFlag } from '../hooks/useFlag';
import {
  inviteAllParticipants,
  readAppContext,
  readMeetingContext,
  readZoomUserSummary,
  requestZoomAuthorizeCode,
  sendChatMessage,
} from '../utils/zoomSdk';
import { getSessionToken } from '../utils/zoomIdentity';
import { trackEvent } from '../utils/posthog';
import ConfirmModal from './ConfirmModal';
import PollVote from './PollVote';

const UpgradeModal = lazy(() => import('./UpgradeModal'));

/**
 * The POLL tab (#80): Best Table Topics Speaker, Best Speaker and Best
 * Evaluator, voted on at the end of the meeting.
 *
 * Setup → open → close, all on this device. The ballot starts from the active
 * template (club, personal or default, see packages/shared/polls.js) filled
 * with this meeting's timed speakers; an edit for one meeting is kept in the
 * poll draft and never touches a template. The Worker holds the votes, so the
 * counts at Close are final. Running a poll is Pro; the vote view above the
 * setup is for everyone.
 */

const NEW_ROLE = '__new_role__';
const POLL_INTERVAL_MS = 5000;

const authHeaders = () => {
  const token = getSessionToken();
  // The club header too: on a club device the club's plan is what makes this Pro.
  return { 'Content-Type': 'application/json', ...clubHeaders(), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
};

async function api(method, path, body) {
  try {
    const response = await fetch(path, {
      method,
      headers: authHeaders(),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { ok: response.ok, status: response.status, body: await response.json().catch(() => null) };
  } catch {
    return { ok: false, status: 0, body: null };
  }
}

/** What goes to the Worker: names only, blanks dropped. */
const ballotToSend = (ballot) => ({
  categories: ballot.categories.map((c) => ({
    role: c.role,
    ...(c.label?.trim() ? { label: c.label.trim() } : {}),
    candidates: c.candidates.map((name) => name.trim()).filter(Boolean),
  })),
});

const templateFrom = (ballot, options) => ({
  categories: ballot.categories.map((c) => ({
    role: c.role,
    ...(c.label?.trim() ? { label: c.label.trim() } : {}),
    slots: Math.max(1, c.candidates.length),
  })),
  options,
});

function PathSplit({ byPath, cat }) {
  const sum = (path) => (byPath?.[path]?.[cat] ?? []).reduce((a, b) => a + Number(b || 0), 0);
  return (
    <p className="text-xs text-gray-500">
      in Zoom {sum('zoom')} · guest {sum('guest')} · link {sum('link')}
    </p>
  );
}

export default function PollTab() {
  const { reports, roleOptions, addRoleRules } = useTimer();
  const { showToast } = useToast();
  const { isPro, known } = useEntitlement();
  const { enabled: proReleased } = useFlag('pro');
  const { enabled: zoomPollsOn } = useFlag('polls_zoom');

  const [template] = useState(() => activePollTemplate());
  const [options, setOptions] = useState(() => template.options);
  const [draft, setDraft] = useState(
    () => loadPollDraft() ?? ballotFromTemplate(template, reports, roleOptions)
  );
  const [newRoleFor, setNewRoleFor] = useState(null);
  const [newRoleName, setNewRoleName] = useState('');
  const [showUpgrade, setShowUpgrade] = useState(false);
  const [showForkConfirm, setShowForkConfirm] = useState(false);
  const forkResolverRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState(null);
  const [closed, setClosed] = useState(null);
  const [isHost, setIsHost] = useState(false);
  const [zoomPollNote, setZoomPollNote] = useState(null);

  const poll = draft.poll ?? null;

  useEffect(() => {
    let alive = true;
    readZoomUserSummary().then((summary) => alive && setIsHost(summary?.role === 'host'));
    return () => {
      alive = false;
    };
  }, []);

  // Counts every five seconds while the poll is open and this tab is showing.
  useEffect(() => {
    if (!poll?.id) return undefined;
    let alive = true;
    const read = async () => {
      const res = await api('GET', `/api/polls/${poll.id}/results`);
      if (alive && res.ok) setLive(res.body);
    };
    read();
    const timer = setInterval(read, POLL_INTERVAL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [poll?.id]);

  /** Every edit lands in the draft, never in a template. */
  const update = (next) => {
    setDraft(next);
    savePollDraft(next);
  };
  const updateCategory = (i, change) =>
    update({ ...draft, categories: draft.categories.map((c, k) => (k === i ? { ...c, ...change } : c)) });

  const candidatesFor = (role) => ballotFromTemplate({ categories: [{ role, slots: 3 }] }, reports, []).categories[0].candidates;

  const setRole = (i, role) => {
    const category = draft.categories[i];
    // An untouched category follows its role; one with names typed in keeps them.
    const untouched = category.candidates.every((name) => !name.trim());
    updateCategory(i, { role, ...(untouched ? { candidates: candidatesFor(role) } : {}) });
  };

  const confirmFork = () =>
    new Promise((resolve) => {
      forkResolverRef.current = resolve;
      setShowForkConfirm(true);
    });

  const settleFork = (confirmed) => {
    setShowForkConfirm(false);
    const resolve = forkResolverRef.current;
    forkResolverRef.current = null;
    resolve?.(confirmed);
  };

  // The same path as Edit Rules: a club device makes its own copy of the club
  // list first, or the new role would land in personal keys behind the club's.
  const addRole = async (i) => {
    const name = newRoleName.trim();
    if (!name) {
      showToast('Please enter a name for the new role.', 'error');
      return;
    }
    if (!roleOptions.includes(name)) {
      const wasClubList = clubPresetsLive();
      if (!(await ensureForked(confirmFork))) return;
      if (wasClubList) trackEvent('club_presets_forked', { surface: 'zoom', club_id: loadClub()?.club?.id ?? null });
      addRoleRules(name, { ...DEFAULT_CUSTOM_RULES });
      trackEvent('role_added', { role: name, rules: DEFAULT_CUSTOM_RULES, surface: 'polls' });
    }
    setNewRoleFor(null);
    setNewRoleName('');
    setRole(i, name);
  };

  const saveTemplate = () => {
    savePollTemplate(templateFrom(draft, options));
    showToast('Saved as your poll template.', 'success');
  };

  const publish = async () => {
    const result = await publishPollTemplate(templateFrom(draft, options), { getToken: getSessionToken });
    showToast(result.ok ? 'Published to the club.' : 'Could not publish to the club. Try again.', result.ok ? 'success' : 'error');
  };

  const openPoll = async () => {
    setBusy(true);
    const ballot = ballotToSend(draft);
    const context = await readAppContext();
    const res = await api('POST', '/api/polls', { ballot, expiryHours: options.expiryHours, context });
    setBusy(false);
    if (!res.ok || !res.body?.id) {
      showToast(res.status === 402 ? 'Running a poll needs Pro.' : 'Could not open the poll. Try again.', 'error');
      return;
    }
    const opened = { id: res.body.id, url: res.body.url, ballot };
    update({ ...draft, poll: opened });
    setClosed(null);
    if (options.postToChat) {
      const posted = await sendChatMessage(`Vote for this meeting's best speakers: ${opened.url}`);
      if (!posted) showToast('Could not post the link to the chat. Use Copy link to share it.', 'warning', 6000);
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(poll.url);
      showToast('Link copied.', 'success');
    } catch {
      showToast('Select the link and copy it.', 'warning');
    }
  };

  const invite = async () => {
    const sent = await inviteAllParticipants().catch(() => false);
    if (sent) {
      showToast('Invitation sent.', 'success');
      trackEvent('poll_invite_sent', {});
    } else {
      showToast('Could not send the invitation. Copy the link and share it instead.', 'warning', 6000);
    }
  };

  const createZoomPoll = async () => {
    setZoomPollNote(null);
    const auth = await requestZoomAuthorizeCode();
    if (auth.status !== 'code') {
      setZoomPollNote('Zoom did not approve the request, so no Zoom poll was created.');
      return;
    }
    const { meetingID } = await readMeetingContext();
    const res = await api('POST', '/api/polls/zoom', {
      code: auth.code,
      codeVerifier: auth.codeVerifier,
      meetingId: meetingID,
      pollId: poll.id,
    });
    if (res.ok) {
      update({ ...draft, poll: { ...poll, zoomPoll: true } });
      setZoomPollNote('Zoom poll created. Launch it from Zoom\'s Polls window; its results show here after the meeting.');
    } else if (/instant/i.test(JSON.stringify(res.body ?? ''))) {
      setZoomPollNote('Zoom polls only work on a scheduled meeting, and this is an instant meeting.');
    } else {
      setZoomPollNote('Zoom could not create the poll. Check that polling is on for your account.');
    }
  };

  const closePoll = async () => {
    setBusy(true);
    const res = await api('POST', `/api/polls/${poll.id}/close`);
    setBusy(false);
    if (!res.ok) {
      showToast('Could not close the poll. Try again.', 'error');
      return;
    }
    const result = { ...closedPollResult(poll.id, poll.ballot, res.body), ...(poll.zoomPoll ? { zoomPoll: true } : {}) };
    savePollResult(result);
    recordPollResults(result, { getToken: getSessionToken });
    // The results live on (Report tab, archive); the draft goes back to setup.
    const { poll: _done, ...rest } = draft;
    update(rest);
    setClosed(result);
    if (options.showOnStage) setStageWinners(result.categories);
  };

  const newPoll = () => {
    setClosed(null);
    setLive(null);
  };

  const showOnStage = () => {
    setStageWinners(closed.categories);
    showToast('The winners are on the Stage. Switch the LIVE tab to Stage to show them.', 'success', 6000);
  };

  const roles = (current) => [...new Set([...roleOptions.filter((r) => r !== BREAK_ROLE), current])];

  const setup = (
    <div className="space-y-4">
      {draft.categories.map((category, i) => (
        <fieldset key={i} className="rounded-lg border border-gray-200 p-3 space-y-2">
          <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-gray-500">Category {i + 1}</legend>
          <div className="flex items-center gap-2">
            <select
              aria-label="Role"
              value={newRoleFor === i ? NEW_ROLE : category.role}
              onChange={(e) => {
                if (e.target.value === NEW_ROLE) {
                  setNewRoleFor(i);
                  setNewRoleName('');
                } else {
                  setNewRoleFor(null);
                  setRole(i, e.target.value);
                }
              }}
              className="flex-1 min-w-0 rounded border border-gray-300 px-2 py-1 text-sm"
            >
              {roles(category.role).map((role) => (
                <option key={role} value={role}>{role}</option>
              ))}
              <option value={NEW_ROLE}>New role…</option>
            </select>
            <button
              type="button"
              onClick={() => update({ ...draft, categories: draft.categories.filter((_, k) => k !== i) })}
              aria-label="Remove category"
              className="p-1 text-gray-400 hover:text-red-600"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
          {newRoleFor === i && (
            <div className="flex items-center gap-2">
              <input
                type="text"
                aria-label="New role name"
                value={newRoleName}
                onChange={(e) => setNewRoleName(e.target.value)}
                className="flex-1 min-w-0 rounded border border-gray-300 px-2 py-1 text-sm"
              />
              <button type="button" onClick={() => addRole(i)} className="px-2 py-1 rounded bg-blue-500 text-white text-sm">
                Add role
              </button>
            </div>
          )}
          <input
            type="text"
            aria-label="Label"
            placeholder={`Label (optional, e.g. Best ${category.role})`}
            value={category.label ?? ''}
            onChange={(e) => updateCategory(i, { label: e.target.value })}
            className="w-full rounded border border-gray-300 px-2 py-1 text-sm"
          />
          {category.candidates.map((name, j) => (
            <div key={j} className="flex items-center gap-2">
              <input
                type="text"
                aria-label={`Candidate ${j + 1}`}
                placeholder="Name"
                value={name}
                onChange={(e) =>
                  updateCategory(i, { candidates: category.candidates.map((n, k) => (k === j ? e.target.value : n)) })
                }
                className="flex-1 min-w-0 rounded border border-gray-300 px-2 py-1 text-sm"
              />
              <button
                type="button"
                onClick={() => updateCategory(i, { candidates: category.candidates.filter((_, k) => k !== j) })}
                aria-label="Remove candidate"
                className="p-1 text-gray-400 hover:text-red-600"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => updateCategory(i, { candidates: [...category.candidates, ''] })}
            className="flex items-center gap-1 text-sm text-blue-600 hover:text-blue-700"
          >
            <Plus className="h-4 w-4" /> Add candidate
          </button>
        </fieldset>
      ))}
      <button
        type="button"
        onClick={() => {
          const role = roles('Table Topics Speech')[0];
          update({ ...draft, categories: [...draft.categories, { role, candidates: candidatesFor(role) }] });
        }}
        className="flex items-center gap-1 text-sm text-blue-600 hover:text-blue-700"
      >
        <Plus className="h-4 w-4" /> Add category
      </button>

      <div className="space-y-1 text-sm text-gray-700">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={options.postToChat} onChange={(e) => setOptions({ ...options, postToChat: e.target.checked })} />
          Post the voting link in the meeting chat
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={options.showOnStage} onChange={(e) => setOptions({ ...options, showOnStage: e.target.checked })} />
          Put the winners on the Stage when the poll closes
        </label>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={openPoll}
          disabled={busy || draft.categories.length === 0}
          className="px-4 py-2 rounded-lg text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50"
        >
          Open poll
        </button>
        <button type="button" onClick={saveTemplate} className="px-3 py-2 rounded-lg text-sm border border-gray-300 hover:bg-gray-50">
          Save as my template
        </button>
        {canPublishPresets() && (
          <button type="button" onClick={publish} className="px-3 py-2 rounded-lg text-sm border border-gray-300 hover:bg-gray-50">
            Publish to club
          </button>
        )}
      </div>
    </div>
  );

  const open = poll && (
    <div className="space-y-3">
      <label className="block text-sm text-gray-700">
        Voting link
        <input type="text" readOnly value={poll.url} className="mt-1 w-full rounded border border-gray-300 px-2 py-1 text-sm" onFocus={(e) => e.target.select()} />
      </label>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={invite} className="px-4 py-2 rounded-lg text-sm font-medium text-white bg-blue-600 hover:bg-blue-700">
          Invite everyone
        </button>
        <button type="button" onClick={copyLink} className="px-3 py-2 rounded-lg text-sm border border-gray-300 hover:bg-gray-50">
          Copy link
        </button>
        <button type="button" onClick={closePoll} disabled={busy} className="px-3 py-2 rounded-lg text-sm border border-gray-300 hover:bg-gray-50 disabled:opacity-50">
          Close poll
        </button>
      </div>
      {poll.ballot.categories.map((category, i) => (
        <div key={i}>
          <h3 className="text-sm font-medium text-gray-800">{categoryTitle(category)}</h3>
          <ul className="text-sm text-gray-700">
            {category.candidates.map((name, j) => (
              <li key={j}>{name}: {Number(live?.counts?.[i]?.[j] ?? 0)}</li>
            ))}
          </ul>
          <PathSplit byPath={live?.byPath} cat={i} />
        </div>
      ))}
      {zoomPollsOn && isHost && (
        <div className="rounded-lg border border-gray-200 p-3 space-y-2">
          <p className="text-xs text-gray-600">
            Only the host can create a Zoom poll. It needs Zoom Pro with polling turned on and works only on a
            scheduled meeting. You launch it and share its results in Zoom&apos;s own Polls window; the results show
            here after the meeting.
          </p>
          <button type="button" onClick={createZoomPoll} className="px-3 py-2 rounded-lg text-sm border border-gray-300 hover:bg-gray-50">
            Create as Zoom poll
          </button>
          {zoomPollNote && <p className="text-sm text-gray-700">{zoomPollNote}</p>}
        </div>
      )}
    </div>
  );

  const reveal = closed && (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold text-gray-900">Winners</h2>
      {closed.categories.map((category, i) => (
        <div key={i}>
          <h3 className="text-sm text-gray-600">{categoryTitle(category)}</h3>
          <p className="text-base font-semibold text-gray-900">
            {category.winners.length ? category.winners.join(', ') : 'No votes'}
          </p>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={showOnStage} className="px-4 py-2 rounded-lg text-sm font-medium text-white bg-blue-600 hover:bg-blue-700">
          Show on Stage
        </button>
        <button type="button" onClick={newPoll} className="px-3 py-2 rounded-lg text-sm border border-gray-300 hover:bg-gray-50">
          New poll
        </button>
      </div>
    </div>
  );

  return (
    <div className="p-4 space-y-4">
      <PollVote />
      {known && !isPro && (
        <div className="flex items-start gap-2 text-sm text-gray-700 bg-blue-50 border border-blue-100 rounded-lg p-3">
          <Lock className="h-4 w-4 mt-0.5 flex-shrink-0 text-gray-500" aria-hidden="true" />
          <span>
            Running a poll is a Pro feature. Voting is free: anyone in the meeting can vote in a poll someone else opens.
            {proReleased && (
              <>
                {' '}
                <button type="button" onClick={() => setShowUpgrade(true)} className="text-blue-600 hover:text-blue-700 underline">
                  Upgrade to Pro
                </button>
              </>
            )}
          </span>
        </div>
      )}
      {isPro && (reveal || open || setup)}
      <ConfirmModal
        isOpen={showForkConfirm}
        title="Make your own copy?"
        message="Adding a role makes your own copy of the club's presets and switches this device to it. The club's list stays where it is, one tap away."
        confirmText="Make my copy"
        cancelText="Cancel"
        onConfirm={() => settleFork(true)}
        onCancel={() => settleFork(false)}
        confirmButtonClass="bg-blue-500 hover:bg-blue-600"
      />
      {showUpgrade && (
        <Suspense fallback={null}>
          <UpgradeModal isOpen onClose={() => setShowUpgrade(false)} source="polls" />
        </Suspense>
      )}
    </div>
  );
}
