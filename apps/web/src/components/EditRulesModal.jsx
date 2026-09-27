import { useState, useEffect, useRef } from 'react';
import { X, Plus, Trash2 } from 'lucide-react';
import { useTimer } from '../context/TimerContext';
import { useToast } from '../context/ToastContext';
import { DEFAULT_ROLE_RULES, getDefaultGraceAfterRed, DEFAULT_CUSTOM_RULES, loadTimeInputMode, saveTimeInputMode } from '@toastmaster-timer/shared';
import {
  activeClubName,
  canPublishPresets,
  clubPresetsAvailable,
  clubPresetsLive,
  ensureForked,
  loadClub,
  loadClubPresets,
  presetSource,
  publishPresets,
  resetToClub,
  resolveActiveRules,
  useClubPresets,
  usePersonalPresets,
} from '@toastmaster-timer/shared';
import ConfirmModal from './ConfirmModal';
import ClubPresetBanner from './ClubPresetBanner';
import TimeInput, { TimeInputModeToggle } from './TimeInput';
import { trackEvent } from '../utils/posthog';

const isBuiltInRole = (role) => role in DEFAULT_ROLE_RULES;

export default function EditRulesModal({ isOpen, onClose }) {
  const { roleRules, roleOptions, updateRoleRules, addRoleRules, removeRoleRules, resetAllRoleRulesToDefaults, reloadRoleRules } = useTimer();
  const { showToast } = useToast();
  const [editedRules, setEditedRules] = useState({});
  const [newRoleNames, setNewRoleNames] = useState({});
  const [showResetAllConfirm, setShowResetAllConfirm] = useState(false);
  const [timeInputMode, setTimeInputMode] = useState(loadTimeInputMode);
  const prevOpenRef = useRef(false);

  // --- the club's list -----------------------------------------------------
  // A club device is on one list or the other, never a blend. These answers
  // change underneath the modal the moment the switch moves or a publish lands,
  // so the switch position is held in state and the rest is read per render.
  const [source, setSource] = useState(presetSource);
  const [publishing, setPublishing] = useState(false);
  const [showForkConfirm, setShowForkConfirm] = useState(false);
  const forkResolverRef = useRef(null);

  const clubName = activeClubName();
  const clubHasPresets = clubPresetsAvailable();
  const clubList = clubHasPresets ? loadClubPresets() : null;
  const clubId = loadClub()?.club?.id ?? null;
  const mayPublish = canPublishPresets();

  useEffect(() => {
    if (isOpen && !prevOpenRef.current) {
      setEditedRules({ ...roleRules });
      setNewRoleNames({});
      setSource(presetSource());
    }
    prevOpenRef.current = isOpen;
  }, [isOpen, roleRules]);

  /** Re-seed the editor from whichever list just became live. */
  const showLiveList = () => {
    reloadRoleRules();
    setEditedRules(resolveActiveRules());
    setNewRoleNames({});
    setSource(presetSource());
  };

  /**
   * The one confirmation that stands between the club's list and an edit.
   * Resolved by the modal below, so every mutating path can await the same
   * promise and do nothing at all on cancel.
   */
  const confirmFork = () => new Promise((resolve) => {
    forkResolverRef.current = resolve;
    setShowForkConfirm(true);
  });

  const settleFork = (confirmed) => {
    setShowForkConfirm(false);
    const resolve = forkResolverRef.current;
    forkResolverRef.current = null;
    resolve?.(confirmed);
  };

  /** Add, update, remove and reset-all all run this first. */
  const guardEdit = async () => {
    const wasClubList = clubPresetsLive();
    const proceed = await ensureForked(confirmFork);
    if (proceed && wasClubList) {
      setSource(presetSource());
      trackEvent('club_presets_forked', { surface: 'web', club_id: clubId });
    }
    return proceed;
  };

  const handleUseClubPresets = () => { useClubPresets(); showLiveList(); };
  const handleUseMyPresets = () => { usePersonalPresets(); showLiveList(); };
  const handleResetToClub = () => {
    if (!resetToClub()) return;
    showLiveList();
    trackEvent('club_presets_reset', { surface: 'web', club_id: clubId });
  };

  const handleRuleChange = (role, field, value) => {
    setEditedRules(prev => ({ ...prev, [role]: { ...prev[role], [field]: value } }));
  };
  const handleAddRole = () => {
    const tempId = `__new_${Date.now()}`;
    setEditedRules(prev => ({ ...prev, [tempId]: { ...DEFAULT_CUSTOM_RULES } }));
    setNewRoleNames(prev => ({ ...prev, [tempId]: 'New role' }));
  };
  const handleNewRoleNameChange = (tempId, name) => setNewRoleNames(prev => ({ ...prev, [tempId]: name }));
  const handleRemoveNewRole = (tempId) => {
    setEditedRules(prev => { const n = { ...prev }; delete n[tempId]; return n; });
    setNewRoleNames(prev => { const n = { ...prev }; delete n[tempId]; return n; });
  };
  const handleRemoveRole = async (role) => {
    if (!(await guardEdit())) return;
    setEditedRules(prev => { const n = { ...prev }; delete n[role]; return n; });
    removeRoleRules(role);
  };

  const rolesToShow = [...(roleOptions ?? []), ...Object.keys(editedRules).filter((k) => k.startsWith('__new_'))];

  /**
   * What "Share with my club" would send: the timings on screen right now.
   * Built from the editor rather than from storage, because the saves run
   * inside a state updater and what is on disk lags the screen by a render.
   */
  const publishablePresets = () => {
    const rules = {};
    for (const role of rolesToShow) {
      const edited = editedRules[role];
      if (!edited) continue;
      const name = role.startsWith('__new_') ? (newRoleNames[role] || '').trim() : role;
      if (!name) continue;
      rules[name] = {
        green: edited.green,
        yellow: edited.yellow,
        red: edited.red,
        graceAfterRed: edited.graceAfterRed ?? getDefaultGraceAfterRed(name),
      };
    }
    return {
      rules,
      order: Object.keys(rules).filter((role) => !(role in DEFAULT_ROLE_RULES)),
      hiddenBuiltins: Object.keys(DEFAULT_ROLE_RULES).filter((role) => !(role in rules)),
    };
  };

  const handlePublish = async () => {
    if (publishing || !validate()) return;
    setPublishing(true);
    // No bearer to send: the web app authenticates with the tt_session cookie,
    // which rides along on a same-origin request.
    const result = await publishPresets(publishablePresets(), {});
    setPublishing(false);

    if (!result.ok) {
      showToast(
        result.error === 'forbidden'
          ? 'Only a club admin or editor can share presets.'
          : "Couldn't share these presets with your club. Try again.",
        'error'
      );
      return;
    }

    if (presetSource() === 'club') showLiveList();
    showToast(`Shared with ${clubName || 'your club'}.`, 'success');
    trackEvent('club_presets_published', {
      surface: 'web',
      club_id: clubId,
      role: loadClub()?.role ?? null,
      roles: Object.keys(publishablePresets().rules).length,
    });
  };

  /** Every reason the list on screen could not be saved or shared. */
  const validate = () => {
    const seenNames = new Set();
    for (const role of rolesToShow) {
      const rules = editedRules[role];
      if (!rules || rules.green <= 0 || rules.yellow <= rules.green || rules.red <= rules.yellow) {
        const displayName = role.startsWith('__new_') ? (newRoleNames[role] || role) : role;
        showToast(`Invalid timing rules for ${displayName}. Green must be > 0, Yellow must be > Green, and Red must be > Yellow.`, 'error');
        return false;
      }
      if (role.startsWith('__new_')) {
        const name = (newRoleNames[role] || '').trim();
        if (!name) { showToast('Please enter a name for the new role.', 'error'); return false; }
        if (seenNames.has(name) || roleOptions.includes(name)) { showToast(`A role named "${name}" already exists.`, 'error'); return false; }
        seenNames.add(name);
      }
    }
    return true;
  };

  const handleSave = async () => {
    if (!validate()) return;
    // Nothing is written until the club's list has been forked, so cancelling
    // the confirmation leaves the modal open with the edit still on screen.
    if (!(await guardEdit())) return;
    for (const role of rolesToShow) {
      const rules = editedRules[role];
      if (role.startsWith('__new_')) {
        const name = (newRoleNames[role] || '').trim();
        if (name) {
          addRoleRules(name, rules);
          trackEvent('role_added', { role: name, rules });
        }
      } else {
        const oldRules = roleRules[role];
        const graceOld = oldRules?.graceAfterRed ?? getDefaultGraceAfterRed(role);
        const graceNew = rules.graceAfterRed ?? getDefaultGraceAfterRed(role);
        if (oldRules && (oldRules.green !== rules.green || oldRules.yellow !== rules.yellow || oldRules.red !== rules.red || graceOld !== graceNew)) {
          updateRoleRules(role, rules);
          trackEvent('rules_edited', { role, rules });
        }
      }
    }
    onClose();
  };

  const handleReset = (role) => {
    const defaultRules = DEFAULT_ROLE_RULES[role];
    if (!defaultRules) return;
    setEditedRules(prev => ({ ...prev, [role]: { ...defaultRules } }));
  };
  const handleResetAll = () => setShowResetAllConfirm(true);
  const handleConfirmResetAll = async () => {
    setShowResetAllConfirm(false);
    if (!(await guardEdit())) return;
    resetAllRoleRulesToDefaults();
    setEditedRules(prev => ({ ...DEFAULT_ROLE_RULES, ...Object.fromEntries(Object.entries(prev).filter(([k]) => !(k in DEFAULT_ROLE_RULES))) }));
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-semibold">Edit Timing Rules</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="h-5 w-5" /></button>
        </div>
        <div className="flex items-center justify-between mb-4">
          <p className="text-sm text-gray-600">Adjust the default timing rules for each speech type.</p>
          <div className="flex items-center gap-1.5 text-xs text-gray-500 shrink-0 ml-4">
            <span>Input:</span>
            <TimeInputModeToggle mode={timeInputMode} onModeChange={(m) => { saveTimeInputMode(m); setTimeInputMode(m); }} />
          </div>
        </div>
        {clubHasPresets && (
          <ClubPresetBanner
            clubName={clubName || 'Your club'}
            source={source}
            onUseClub={handleUseClubPresets}
            onUseMine={handleUseMyPresets}
            onResetToClub={handleResetToClub}
          />
        )}

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
                    <input type="text" value={newRoleNames[role] || ''} onChange={(e) => handleNewRoleNameChange(role, e.target.value)} placeholder="Role name" className="flex-1 font-semibold text-gray-900 px-2 py-1 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm" />
                  ) : (
                    <h4 className="font-semibold text-gray-900">{role}</h4>
                  )}
                  <div className="flex items-center gap-2">
                    {builtIn && <button onClick={() => handleReset(role)} className="text-xs text-blue-600 hover:text-blue-800">Reset to Default</button>}
                    <button onClick={() => isNew ? handleRemoveNewRole(role) : handleRemoveRole(role)} className="text-xs text-red-600 hover:text-red-800 flex items-center gap-1" aria-label="Remove role"><Trash2 className="h-3.5 w-3.5" /> Remove</button>
                  </div>
                </div>
                <div className="grid grid-cols-4 gap-4">
                  <TimeInput label="Green" value={rules.green} onChange={(v) => handleRuleChange(role, 'green', v)} />
                  <TimeInput label="Yellow" value={rules.yellow} onChange={(v) => handleRuleChange(role, 'yellow', v)} />
                  <TimeInput label="Red" value={rules.red} onChange={(v) => handleRuleChange(role, 'red', v)} />
                  <TimeInput label="Grace" value={graceValue} onChange={(v) => handleRuleChange(role, 'graceAfterRed', v)} />
                </div>
                {hasError && <div className="text-xs text-red-600 mt-2">Invalid: Yellow must be &gt; Green, Red must be &gt; Yellow</div>}
              </div>
            );
          })}
        </div>
        <button type="button" onClick={handleAddRole} className="mt-2 flex items-center gap-2 px-3 py-2 text-sm font-medium text-blue-600 hover:text-blue-800 hover:bg-blue-50 rounded-lg border border-dashed border-gray-300"><Plus className="h-4 w-4" /> Add role</button>
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
          <button onClick={handleResetAll} className="px-4 py-2 bg-gray-200 hover:bg-gray-300 text-gray-800 font-semibold rounded-lg text-sm">Reset All to Defaults</button>
          <div className="flex-1" />
          <button onClick={onClose} className="px-4 py-2 bg-gray-300 hover:bg-gray-400 text-gray-800 font-semibold rounded-lg text-sm">Cancel</button>
          <button onClick={handleSave} className="px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white font-semibold rounded-lg text-sm">Save Changes</button>
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
      <ConfirmModal isOpen={showResetAllConfirm} title="Reset All Rules" message="Are you sure you want to reset all built-in timing rules to defaults? Custom roles will be kept." confirmText="Reset All" cancelText="Cancel" onConfirm={handleConfirmResetAll} onCancel={() => setShowResetAllConfirm(false)} confirmButtonClass="bg-blue-500 hover:bg-blue-600" />
    </div>
  );
}
