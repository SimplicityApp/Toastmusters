import { useEffect, useState } from 'react';
import { ChevronDown, Plus, Trash2, Users } from 'lucide-react';
import { DEFAULT_CUSTOM_RULES, DEFAULT_ROLE_RULES, getDefaultGraceAfterRed, saveTimeInputMode } from '@toastmaster-timer/shared';
import { useRulesEditor } from '../hooks/useRulesEditor';
import ConfirmModal from '../components/ConfirmModal';
import Sheet from './Sheet';
import { TimeField, TimeModeSwitch } from './TimerPanels';
import { thresholdsLine } from './format';

/** The rules a row is showing: as edited, or the defaults it would start from. */
function rulesFor(role, editedRules) {
  const isNew = role.startsWith('__new_');
  const rules = editedRules[role] ?? (isNew ? { ...DEFAULT_CUSTOM_RULES } : DEFAULT_ROLE_RULES[role] ?? { ...DEFAULT_CUSTOM_RULES });
  const grace = rules.graceAfterRed ?? (isNew ? 30 : getDefaultGraceAfterRed(role));
  return { isNew, rules, grace, invalid: rules.yellow <= rules.green || rules.red <= rules.yellow };
}

/**
 * Roles & timing rules (board B-L08): every role as a row showing its times;
 * one opens at a time to edit them. The club's list, sharing with the club,
 * Reset all and Save work as in today's dialog, from useRulesEditor.
 */
export default function RulesSheet({ open, onClose }) {
  const e = useRulesEditor({ isOpen: open, onClose });
  const [expanded, setExpanded] = useState(null);
  const onClub = e.source === 'club';

  // A role added a moment ago opens, so its name can be typed straight away.
  const newest = e.rolesToShow.filter((role) => role.startsWith('__new_')).slice(-1)[0] ?? null;
  useEffect(() => {
    if (newest) setExpanded(newest);
  }, [newest]);
  useEffect(() => {
    if (!open) setExpanded(null);
  }, [open]);

  const changeMode = (mode) => {
    saveTimeInputMode(mode);
    e.setTimeInputMode(mode);
  };

  return (
    <>
      <Sheet open={open} onClose={onClose} title="Roles & timing rules">
        <div className="mb-3 flex items-center gap-2">
          <p className="m-0 flex-1 text-[13px] text-slate-500">The times each role starts with.</p>
          <TimeModeSwitch mode={e.timeInputMode} onModeChange={changeMode} />
        </div>

        {e.clubHasPresets && (
          <div className="mb-3 rounded-xl border border-blue-200 bg-blue-50 px-3 py-2.5 text-[13px] text-blue-900">
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 flex-shrink-0 text-blue-600" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                {onClub ? (
                  <>
                    Using <strong>{e.clubName || 'your club'}</strong>&apos;s timings
                  </>
                ) : (
                  'Using your own timings'
                )}
              </span>
              <button
                type="button"
                onClick={onClub ? e.handleUseMyPresets : e.handleUseClubPresets}
                className="flex-shrink-0 rounded-lg border border-blue-200 bg-white px-2.5 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-100"
              >
                {onClub ? 'Use mine' : `Use ${e.clubName || 'the club'}'s`}
              </button>
            </div>
            {!onClub && (
              <button type="button" onClick={e.handleResetToClub} className="mt-1.5 text-xs font-semibold text-blue-700 hover:underline">
                Reset to the club&apos;s timings
              </button>
            )}
          </div>
        )}
        {!e.clubHasPresets && e.lapsedClub && (
          <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-900">
            <strong className="block text-[13px]">{e.lapsedClub}&apos;s Pro has ended</strong>
            These are your own timings again. Nothing was deleted: when the club renews, its shared timings come back.
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          {e.rolesToShow.map((role) => {
            const { isNew, rules, grace, invalid } = rulesFor(role, e.editedRules);
            const name = isNew ? e.newRoleNames[role] || 'New role' : role;
            const builtIn = !isNew && role in DEFAULT_ROLE_RULES;
            if (expanded !== role) {
              return (
                <button
                  key={role}
                  type="button"
                  onClick={() => setExpanded(role)}
                  aria-expanded={false}
                  className={`flex items-center gap-2 rounded-xl border px-3 py-2.5 text-left text-sm hover:bg-slate-50 ${invalid ? 'border-red-300' : 'border-gray-200'}`}
                >
                  <span className="min-w-0 flex-1 truncate">{name}</span>
                  <span className="flex-shrink-0 text-xs text-slate-500">{thresholdsLine(rules)}</span>
                  <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-slate-400" aria-hidden="true" />
                </button>
              );
            }
            return (
              <div key={role} className="rounded-xl border-2 border-blue-600 px-3 py-2.5">
                <div className="mb-2 flex items-center gap-2">
                  {isNew ? (
                    <input
                      value={e.newRoleNames[role] || ''}
                      onChange={(event) => e.handleNewRoleNameChange(role, event.target.value)}
                      placeholder="Role name"
                      aria-label="Role name"
                      className="h-8 min-w-0 flex-1 rounded-lg border border-gray-300 px-2 text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  ) : (
                    <button type="button" onClick={() => setExpanded(null)} aria-expanded className="min-w-0 flex-1 truncate text-left text-sm font-bold">
                      {role}
                    </button>
                  )}
                  {builtIn && (
                    <button type="button" onClick={() => e.handleReset(role)} className="flex-shrink-0 text-xs font-semibold text-blue-600 hover:underline">
                      Reset
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => (isNew ? e.handleRemoveNewRole(role) : e.handleRemoveRole(role))}
                    aria-label={`Remove ${name}`}
                    className="flex-shrink-0 rounded p-1 text-slate-400 hover:text-red-600"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>
                <div className="grid grid-cols-4 gap-1.5">
                  <TimeField label="Green" tone="text-green-700" value={rules.green} mode={e.timeInputMode} onChange={(v) => e.handleRuleChange(role, 'green', v)} />
                  <TimeField label="Yellow" tone="text-yellow-700" value={rules.yellow} mode={e.timeInputMode} onChange={(v) => e.handleRuleChange(role, 'yellow', v)} />
                  <TimeField label="Red" tone="text-red-700" value={rules.red} mode={e.timeInputMode} onChange={(v) => e.handleRuleChange(role, 'red', v)} />
                  <TimeField label="Grace" value={grace} mode={e.timeInputMode} onChange={(v) => e.handleRuleChange(role, 'graceAfterRed', v)} />
                </div>
                {invalid && <p className="mb-0 mt-1.5 text-xs text-red-600">Yellow must be after Green, and Red after Yellow.</p>}
              </div>
            );
          })}
          <button
            type="button"
            onClick={e.handleAddRole}
            className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-slate-300 py-2.5 text-sm text-slate-700 hover:bg-slate-50"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            Add role
          </button>

          {e.mayPublish && (
            <div className="mt-1 flex items-center gap-2.5 rounded-xl bg-slate-50 px-3 py-2.5 text-xs text-slate-600">
              <span className="min-w-0 flex-1">
                <strong className="block text-[13px] text-gray-900">{e.clubName || 'Your club'}</strong>
                {e.clubList?.publishedAt
                  ? `Last shared ${new Date(e.clubList.publishedAt).toLocaleDateString()}.`
                  : 'Nothing shared with your club yet.'}{' '}
                Sharing replaces the list on every club timer.
              </span>
              <button
                type="button"
                onClick={e.handlePublish}
                disabled={e.publishing}
                className="flex-shrink-0 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
              >
                {e.publishing ? 'Sharing…' : 'Share'}
              </button>
            </div>
          )}
        </div>

        <div className="sticky bottom-0 -mx-4 mt-4 flex gap-2 border-t border-slate-100 bg-white px-4 pt-3">
          <button type="button" onClick={e.handleResetAll} className="h-11 rounded-xl border border-gray-300 px-4 text-sm font-semibold hover:bg-slate-50">
            Reset all
          </button>
          <button type="button" onClick={e.handleSave} className="h-11 flex-1 rounded-xl bg-blue-600 text-sm font-bold text-white hover:bg-blue-700">
            Save
          </button>
        </div>
      </Sheet>

      <ConfirmModal
        isOpen={e.showForkConfirm}
        title="Make your own copy?"
        message={`These are ${e.clubName || 'your club'}'s timings. Saving makes your own copy and switches this device to it. The club's list stays where it is, one tap away.`}
        confirmText="Make my copy"
        cancelText="Cancel"
        onConfirm={() => e.settleFork(true)}
        onCancel={() => e.settleFork(false)}
        confirmButtonClass="bg-blue-500 hover:bg-blue-600"
      />
      <ConfirmModal
        isOpen={e.showResetAllConfirm}
        title="Reset all rules"
        message="Reset every built-in role to its default times? Your own roles stay."
        confirmText="Reset all"
        cancelText="Cancel"
        onConfirm={e.handleConfirmResetAll}
        onCancel={() => e.setShowResetAllConfirm(false)}
        confirmButtonClass="bg-blue-500 hover:bg-blue-600"
      />
    </>
  );
}
