import { useEffect, useState } from 'react';
import {
  CLUB_PROMPT,
  PRO_LAUNCH_PROMPT,
  PROMPT_ORDER,
  PROMPT_RULES,
  REVIEW_PROMPT,
  forcePrompt,
  isPromptDebugMode,
  loadPromptState,
  recordSpeechFinished,
  resetPromptState,
  selectDuePrompt,
  subscribeToPromptState,
} from '@toastmaster-timer/shared';

const LABELS = {
  [PRO_LAUNCH_PROMPT]: 'Pro launch',
  [CLUB_PROMPT]: 'Club survey',
  [REVIEW_PROMPT]: 'Review ask',
};

/**
 * Debug-panel controls for the periodic prompts. Waiting out three speeches (or
 * fourteen days) to see a prompt makes them untestable by hand, so this puts the
 * modals and the cadence state one click away.
 *
 * "Show" bypasses every gate without recording an ask, so it never skews the
 * cadence; "+1 speech" drives the real path instead, exactly as FINISH does.
 */
export default function PromptDebugControls() {
  const [state, setState] = useState(loadPromptState);

  useEffect(() => subscribeToPromptState(setState), []);

  // Every prompt, the Pro announcement included, whatever the release gate says:
  // this panel shows the cadence, not who is eligible.
  const duePrompt = selectDuePrompt(state, Date.now(), PROMPT_ORDER);

  return (
    <div className="mt-3 pt-3 border-t border-gray-200">
      <div className="font-semibold text-gray-700 mb-2">Periodic Prompts:</div>

      <div className="text-gray-600 mb-2">
        <div>Speeches finished: {state.speechesFinished}</div>
        <div>Time gates: {isPromptDebugMode() ? 'ignored (debug build)' : 'enforced'}</div>
        <div>Due now: {duePrompt ? LABELS[duePrompt] : 'none'}</div>
      </div>

      <div className="space-y-1">
        {PROMPT_ORDER.map((key) => {
          const record = state.prompts[key];
          return (
            <div key={key} className="flex items-center justify-between gap-2 bg-gray-100 rounded px-2 py-1">
              <span className="text-gray-700">
                {LABELS[key]}: {record.asks}/{PROMPT_RULES[key].maxAsks} asks
                {record.resolution ? `, ${record.resolution}` : ''}
                {duePrompt === key ? ' · due' : ''}
              </span>
              <button
                onClick={() => forcePrompt(key)}
                className="text-blue-600 hover:text-blue-800 underline flex-shrink-0"
              >
                Show
              </button>
            </div>
          );
        })}
      </div>

      <div className="flex gap-3 mt-2">
        <button
          onClick={() => recordSpeechFinished()}
          className="text-gray-600 hover:text-gray-800 underline"
        >
          +1 speech
        </button>
        <button
          onClick={() => resetPromptState()}
          className="text-gray-600 hover:text-gray-800 underline"
        >
          Reset history
        </button>
      </div>
    </div>
  );
}
