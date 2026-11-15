import { useEffect, useState } from 'react';
import { Vote } from 'lucide-react';
import { categoryTitle, loadPollDraft } from '@toastmaster-timer/shared';
import { readAppContext } from '../utils/zoomSdk';

/**
 * Voting in a poll someone opened in this meeting (#80, AC-14). Any plan,
 * guests included: running a poll is Pro, voting never is.
 *
 * "Invite everyone" carries no data, so the invited app finds the poll itself:
 * it sends Zoom's encrypted app context and the Worker answers with the open
 * poll for that meeting. The vote goes back with the same context, which is
 * what keys it to the voter's Zoom account (or, for a guest, to this device).
 * Outside Zoom there is no context; the Worker still decides.
 */

const DEVICE_STORAGE_KEY = 'toastmaster_poll_device';

// Polls this device has voted in, so the banner stops asking. Local only: the
// Worker is what refuses a second vote.
const VOTED_STORAGE_KEY = 'toastmaster_poll_voted';
const voted = {
  has: (id) => {
    try {
      return JSON.parse(localStorage.getItem(VOTED_STORAGE_KEY) ?? '[]').includes(id);
    } catch {
      return false;
    }
  },
  add: (id) => {
    try {
      // The last few only: a poll lives a day at most.
      const ids = JSON.parse(localStorage.getItem(VOTED_STORAGE_KEY) ?? '[]').filter((v) => v !== id);
      localStorage.setItem(VOTED_STORAGE_KEY, JSON.stringify([...ids, id].slice(-20)));
    } catch {
      // Private mode: the banner may ask again; the Worker still refuses a repeat.
    }
  },
};

/** A random token for this device, kept so one device is one guest vote. */
function deviceToken() {
  try {
    let token = localStorage.getItem(DEVICE_STORAGE_KEY);
    if (!token) {
      token = globalThis.crypto?.randomUUID?.() ?? `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      localStorage.setItem(DEVICE_STORAGE_KEY, token);
    }
    return token;
  } catch {
    return null;
  }
}

/**
 * The poll open in this meeting that this device did not open itself, or null.
 *
 * @returns {Promise<{id: string, ballot: Object, context: string|null}|null>}
 */
export async function findCurrentPoll() {
  const context = await readAppContext();
  try {
    const response = await fetch('/api/polls/current', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context }),
    });
    if (!response.ok) return null;
    const body = await response.json();
    if (!body?.id || !Array.isArray(body.ballot?.categories)) return null;
    if (body.id === loadPollDraft()?.poll?.id) return null;
    return { id: body.id, ballot: body.ballot, context };
  } catch {
    return null;
  }
}

/** "Vote now", above the tabs, while a poll is open and this device has not voted. */
export function PollVoteBanner({ onOpen }) {
  const [poll, setPoll] = useState(null);

  useEffect(() => {
    let live = true;
    findCurrentPoll().then((found) => live && setPoll(found));
    return () => {
      live = false;
    };
  }, []);

  if (!poll || voted.has(poll.id)) return null;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700"
    >
      <Vote className="h-4 w-4" aria-hidden="true" />
      A poll is open in this meeting. Vote now
    </button>
  );
}

const ERRORS = {
  409: 'You already voted in this poll.',
  403: 'This poll belongs to another meeting.',
  404: 'This poll has closed.',
  410: 'This poll has closed.',
};

export default function PollVote() {
  const [poll, setPoll] = useState(null);
  const [choices, setChoices] = useState({});
  const [phase, setPhase] = useState('voting'); // voting | sending | done
  const [error, setError] = useState(null);

  useEffect(() => {
    let live = true;
    findCurrentPoll().then((found) => {
      if (!live || !found) return;
      setPoll(found);
      if (voted.has(found.id)) setPhase('done');
    });
    return () => {
      live = false;
    };
  }, []);

  if (!poll) return null;

  const submit = async () => {
    setPhase('sending');
    setError(null);
    let status = 0;
    try {
      const response = await fetch(`/api/polls/${poll.id}/votes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ choices, context: poll.context, device: deviceToken() }),
      });
      status = response.status;
    } catch {
      status = 0;
    }
    if (status >= 200 && status < 300) {
      voted.add(poll.id);
      setPhase('done');
      return;
    }
    if (status === 409) voted.add(poll.id);
    setError(ERRORS[status] ?? 'Could not send your vote. Try again.');
    setPhase('voting');
  };

  return (
    <section aria-label="Vote" className="rounded-lg border border-blue-200 bg-blue-50 p-4 space-y-3">
      <h2 className="text-sm font-semibold text-gray-900">Vote in this meeting&apos;s poll</h2>
      {phase === 'done' ? (
        <p className="text-sm text-gray-700">Thanks, your vote is in.</p>
      ) : (
        <>
          {poll.ballot.categories.map((category, i) =>
            category.candidates?.length ? (
              <fieldset key={i} className="space-y-1">
                <legend className="text-sm font-medium text-gray-800">{categoryTitle(category)}</legend>
                {category.candidates.map((name, j) => (
                  <label key={j} className="flex items-center gap-2 text-sm text-gray-700">
                    <input
                      type="radio"
                      name={`poll-${poll.id}-${i}`}
                      checked={choices[i] === j}
                      onChange={() => setChoices((prev) => ({ ...prev, [i]: j }))}
                    />
                    {name}
                  </label>
                ))}
              </fieldset>
            ) : null
          )}
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button
            type="button"
            onClick={submit}
            disabled={phase === 'sending' || Object.keys(choices).length === 0}
            className="px-4 py-2 rounded-lg text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50"
          >
            Submit vote
          </button>
        </>
      )}
    </section>
  );
}
