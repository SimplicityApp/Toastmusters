import { X, Plus, Trash2 } from 'lucide-react';
import { DEFAULT_ROLE_RULES, getDefaultGraceAfterRed, DEFAULT_CUSTOM_RULES, saveTimeInputMode } from '@toastmaster-timer/shared';
import ConfirmModal from './ConfirmModal';
import ClubPresetBanner from './ClubPresetBanner';
import TimeInput, { TimeInputModeToggle } from './TimeInput';
import { useRulesEditor } from '../hooks/useRulesEditor';

const isBuiltInRole = (role) => role in DEFAULT_ROLE_RULES;

export default function EditRulesModal({ isOpen, onClose }) {
  const {
    editedRules,
    newRoleNames,
    showResetAllConfirm,
    setShowResetAllConfirm,
    timeInputMode,
    setTimeInputMode,
    source,
    publishing,
    showForkConfirm,
    clubName,
    clubHasPresets,
    lapsedClub,
    clubList,
    mayPublish,
    settleFork,
    handleUseClubPresets,
    handleUseMyPresets,
    handleResetToClub,
    handleRuleChange,
    handleAddRole,
    handleNewRoleNameChange,
    handleRemoveNewRole,
    handleRemoveRole,
    rolesToShow,
    handlePublish,
    handleSave,
    handleReset,
    handleResetAll,
    handleConfirmResetAll,
  } = useRulesEditor({ isOpen, onClose });

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-semibold">Edit Timing Rules</h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex items-center justify-between mb-4">
          <p className="text-sm text-gray-600">
            Adjust the default timing rules for each speech type. These values will be used as defaults when selecting each role.
          </p>
          <div className="flex items-center gap-1.5 text-xs text-gray-500 shrink-0 ml-4">
            <span>Input:</span>
            <TimeInputModeToggle mode={timeInputMode} onModeChange={(m) => { saveTimeInputMode(m); setTimeInputMode(m); }} />
          </div>
        </div>

        {clubHasPresets ? (
          <ClubPresetBanner
            clubName={clubName || 'Your club'}
            source={source}
            onUseClub={handleUseClubPresets}
            onUseMine={handleUseMyPresets}
            onResetToClub={handleResetToClub}
          />
        ) : lapsedClub ? (
          /* The club's list is still sitting in its own key, untouched. Saying
             so is the difference between "our presets were deleted" and "our
             subscription ended", and only one of those is worth renewing over. */
          <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3">
            <p className="text-sm font-semibold text-gray-900">{lapsedClub}&apos;s Pro has ended</p>
            <p className="text-xs text-gray-600 mt-0.5">
              These are your own timings again. Nothing was deleted — when the club renews, its
              shared presets come back on the next refresh with nothing to re-enter.
            </p>
          </div>
        ) : null}

        <div className="space-y-4">
          {rolesToShow.map((role) => {
            const isNew = role.startsWith('__new_');
            const defaultRules = DEFAULT_CUSTOM_RULES;
            const rules = editedRules[role] ?? (isNew ? { ...defaultRules } : DEFAULT_ROLE_RULES[role] ?? { ...defaultRules });
            const graceValue = rules.graceAfterRed ?? (isNew ? 30 : getDefaultGraceAfterRed(role));
            const hasError = !rules || rules.yellow <= rules.green || rules.red <= rules.yellow;
            const builtIn = !isNew && isBuiltInRole(role);

            return (
              <div key={role} className="border border-gray-200 rounded-lg p-4">
                <div className="flex justify-between items-center mb-3 gap-2">
                  {isNew ? (
                    <input
                      type="text"
                      value={newRoleNames[role] || ''}
                      onChange={(e) => handleNewRoleNameChange(role, e.target.value)}
                      placeholder="Role name"
                      className="flex-1 font-semibold text-gray-900 px-2 py-1 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                    />
                  ) : (
                    <h4 className="font-semibold text-gray-900">{role}</h4>
                  )}
                  <div className="flex items-center gap-2">
                    {builtIn && (
                      <button
                        onClick={() => handleReset(role)}
                        className="text-xs text-blue-600 hover:text-blue-800"
                      >
                        Reset to Default
                      </button>
                    )}
                    <button
                      onClick={() => isNew ? handleRemoveNewRole(role) : handleRemoveRole(role)}
                      className="text-xs text-red-600 hover:text-red-800 flex items-center gap-1"
                      aria-label="Remove role"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Remove
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-4 gap-4">
                  <TimeInput label="Green" value={rules.green} onChange={(v) => handleRuleChange(role, 'green', v)} />
                  <TimeInput label="Yellow" value={rules.yellow} onChange={(v) => handleRuleChange(role, 'yellow', v)} />
                  <TimeInput label="Red" value={rules.red} onChange={(v) => handleRuleChange(role, 'red', v)} />
                  <TimeInput label="Grace" value={graceValue} onChange={(v) => handleRuleChange(role, 'graceAfterRed', v)} />
                </div>

                {hasError && (
                  <div className="text-xs text-red-600 mt-2">
                    Invalid: Yellow must be &gt; Green, Red must be &gt; Yellow
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <button
          type="button"
          onClick={handleAddRole}
          className="mt-2 flex items-center gap-2 px-3 py-2 text-sm font-medium text-blue-600 hover:text-blue-800 hover:bg-blue-50 rounded-lg border border-dashed border-gray-300"
        >
          <Plus className="h-4 w-4" />
          Add role
        </button>

        {mayPublish && (
          <div className="mt-6 rounded-lg border border-gray-200 bg-gray-50 p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-gray-900">{clubName || 'Your club'}</p>
                <p className="text-xs text-gray-600 mt-0.5">
                  {clubList?.publishedAt
                    ? `Last shared ${new Date(clubList.publishedAt).toLocaleDateString()}.`
                    : 'Nothing shared with your club yet.'}
                  {' '}Sharing replaces the list on every device in the club.
                </p>
              </div>
              <button
                type="button"
                onClick={handlePublish}
                disabled={publishing}
                className="px-3 py-2 bg-blue-500 hover:bg-blue-600 disabled:opacity-60 text-white font-semibold rounded-lg transition-colors text-sm flex-shrink-0"
              >
                {publishing ? 'Sharing…' : 'Share with my club'}
              </button>
            </div>
          </div>
        )}

        <div className="flex gap-2 mt-6">
          <button
            onClick={handleResetAll}
            className="px-4 py-2 bg-gray-200 hover:bg-gray-300 text-gray-800 font-semibold rounded-lg transition-colors text-sm"
          >
            Reset All to Defaults
          </button>
          <div className="flex-1" />
          <button
            onClick={onClose}
            className="px-4 py-2 bg-gray-300 hover:bg-gray-400 text-gray-800 font-semibold rounded-lg transition-colors text-sm"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white font-semibold rounded-lg transition-colors text-sm"
          >
            Save Changes
          </button>
        </div>
      </div>

      <ConfirmModal
        isOpen={showForkConfirm}
        title="Make your own copy?"
        message={`These are ${clubName || 'your club'}'s presets. Saving makes your own copy and switches this device to it. The club's list stays where it is, one tap away.`}
        confirmText="Make my copy"
        cancelText="Cancel"
        onConfirm={() => settleFork(true)}
        onCancel={() => settleFork(false)}
        confirmButtonClass="bg-blue-500 hover:bg-blue-600"
      />

      <ConfirmModal
        isOpen={showResetAllConfirm}
        title="Reset All Rules"
        message="Are you sure you want to reset all built-in timing rules to defaults? Custom roles will be kept."
        confirmText="Reset All"
        cancelText="Cancel"
        onConfirm={handleConfirmResetAll}
        onCancel={() => setShowResetAllConfirm(false)}
        confirmButtonClass="bg-blue-500 hover:bg-blue-600"
      />
    </div>
  );
}
