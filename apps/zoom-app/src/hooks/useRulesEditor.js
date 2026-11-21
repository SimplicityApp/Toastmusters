import { useState, useEffect, useRef } from 'react';
import { useTimer } from '../context/TimerContext';
import { useToast } from '../context/ToastContext';
import { DEFAULT_ROLE_RULES, getDefaultGraceAfterRed, DEFAULT_CUSTOM_RULES, loadTimeInputMode, BREAK_ROLE, activeClubName, canPublishPresets, lapsedClubName, clubPresetsAvailable, clubPresetsLive, ensureForked, loadClub, loadClubPresets, presetSource, publishPresets, resetToClub, resolveActiveRules, useClubPresets, usePersonalPresets } from '@toastmaster-timer/shared';
import { trackEvent } from '../utils/posthog';
import { getSessionToken } from '../utils/zoomIdentity';

/**
 * Everything the Roles & timing rules editor does, apart from how it looks:
 * the roles and their times as edited, new roles, removing and resetting, the
 * club's list (use it, use mine, reset to the club's), sharing a list with the
 * club, and saving.
 *
 * Lifted out of EditRulesModal unchanged so design B's rules sheet (plan 13)
 * edits the same rules without a second copy of the logic.
 *
 * @param {{isOpen: boolean, onClose: () => void}} options
 * @returns {Object} state and handlers for a rules view
 */
export function useRulesEditor({ isOpen, onClose }) {
  const { roleRules, roleOptions, updateRoleRules, addRoleRules, removeRoleRules, resetAllRoleRulesToDefaults, reloadRoleRules } = useTimer();
  const { showToast } = useToast();
  const [editedRules, setEditedRules] = useState({});
  const [newRoleNames, setNewRoleNames] = useState({});
  const [showResetAllConfirm, setShowResetAllConfirm] = useState(false);
  const [timeInputMode, setTimeInputMode] = useState(loadTimeInputMode);
  const prevOpenRef = useRef(false);

  // --- the club's list -----------------------------------------------------
  // Read once per open and kept in state, because every one of these answers
  // changes underneath the modal as soon as the switch moves or a publish lands.
  const [source, setSource] = useState(presetSource);
  const [publishing, setPublishing] = useState(false);
  const [showForkConfirm, setShowForkConfirm] = useState(false);
  const forkResolverRef = useRef(null);

  const clubName = activeClubName();
  const clubHasPresets = clubPresetsAvailable();
  // A lapse leaves the club's list where it is and simply stops applying it, so
  // the editor owes the timer an explanation rather than a silent reversion.
  const lapsedClub = lapsedClubName();
  const clubList = clubHasPresets ? loadClubPresets() : null;
  const clubId = loadClub()?.club?.id ?? null;
  const mayPublish = canPublishPresets();

  /** Re-seed the editor from whichever list just became live. */
  const showLiveList = () => {
    reloadRoleRules();
    const merged = resolveActiveRules();
    delete merged[BREAK_ROLE];
    setEditedRules(merged);
    setNewRoleNames({});
    setSource(presetSource());
  };

  /**
   * The one confirmation that stands between the club's list and an edit.
   *
   * Resolved by the modal below rather than returned directly, so every
   * mutating path can `await` the same promise and do nothing at all on cancel.
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

  /**
   * Add, update, remove and reset-all all run this first, so they cannot drift
   * into four behaviours. False means the timer cancelled: write nothing, and
   * leave the modal exactly as it was.
   */
  const guardEdit = async () => {
    const wasClubList = clubPresetsLive();
    const proceed = await ensureForked(confirmFork);
    if (proceed && wasClubList) {
      setSource(presetSource());
      trackEvent('club_presets_forked', { surface: 'zoom', club_id: clubId });
    }
    return proceed;
  };

  const handleUseClubPresets = () => {
    useClubPresets();
    showLiveList();
  };

  const handleUseMyPresets = () => {
    usePersonalPresets();
    showLiveList();
  };

  const handleResetToClub = () => {
    if (!resetToClub()) return;
    showLiveList();
    trackEvent('club_presets_reset', { surface: 'zoom', club_id: clubId });
  };

  // Initialize edited rules only when modal opens (not when roleRules changes while open)
  useEffect(() => {
    if (isOpen && !prevOpenRef.current) {
      setEditedRules({ ...roleRules });
      setNewRoleNames({});
      setSource(presetSource());
    }
    prevOpenRef.current = isOpen;
  }, [isOpen, roleRules]);

  const handleRuleChange = (role, field, value) => {
    setEditedRules(prev => ({
      ...prev,
      [role]: {
        ...prev[role],
        [field]: value
      }
    }));
  };

  const handleAddRole = () => {
    const tempId = `__new_${Date.now()}`;
    setEditedRules(prev => ({
      ...prev,
      [tempId]: { ...DEFAULT_CUSTOM_RULES }
    }));
    setNewRoleNames(prev => ({ ...prev, [tempId]: 'New role' }));
  };

  const handleNewRoleNameChange = (tempId, name) => {
    setNewRoleNames(prev => ({ ...prev, [tempId]: name }));
  };

  const handleRemoveNewRole = (tempId) => {
    setEditedRules(prev => {
      const next = { ...prev };
      delete next[tempId];
      return next;
    });
    setNewRoleNames(prev => {
      const next = { ...prev };
      delete next[tempId];
      return next;
    });
  };

  const handleRemoveRole = async (role) => {
    if (!(await guardEdit())) return;
    setEditedRules(prev => {
      const next = { ...prev };
      delete next[role];
      return next;
    });
    removeRoleRules(role);
  };

  // Break is not editable here: its thresholds are derived from the length
  // picked on the Live tab, so a hand-edited copy would be overwritten by the
  // next pick and mislead in the meantime.
  const rolesToShow = [
    ...(roleOptions ?? []).filter((role) => role !== BREAK_ROLE),
    ...Object.keys(editedRules).filter((k) => k.startsWith('__new_'))
  ];

  /**
   * What "Share with my club" would send: the timings on screen right now.
   *
   * Built from the editor rather than from storage because the saves below run
   * inside a state updater, so what is on disk lags what the officer is looking
   * at by a render. A publish that silently shared the previous list would be
   * the worst possible bug in this feature.
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
      // A built-in missing from the list is a built-in the officer removed, and
      // every device in the club has to stop offering it.
      hiddenBuiltins: Object.keys(DEFAULT_ROLE_RULES).filter((role) => !(role in rules)),
    };
  };

  const handlePublish = async () => {
    if (publishing || !validate()) return;
    setPublishing(true);
    const result = await publishPresets(publishablePresets(), { getToken: getSessionToken });
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

    // rememberPublishedPresets already took the new list and version, so a
    // device sitting on the club's list is showing what was just shared.
    if (presetSource() === 'club') showLiveList();
    showToast(`Shared with ${clubName || 'your club'}.`, 'success');
    trackEvent('club_presets_published', {
      surface: 'zoom',
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
        if (!name) {
          showToast('Please enter a name for the new role.', 'error');
          return false;
        }
        if (seenNames.has(name) || roleOptions.includes(name)) {
          showToast(`A role named "${name}" already exists.`, 'error');
          return false;
        }
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
        if (oldRules && (
          oldRules.green !== rules.green ||
          oldRules.yellow !== rules.yellow ||
          oldRules.red !== rules.red ||
          graceOld !== graceNew
        )) {
          updateRoleRules(role, rules);
          trackEvent('rules_edited', {
            role,
            new_rules: rules,
            previous_rules: oldRules
          });
        }
      }
    }

    onClose();
  };

  const handleReset = (role) => {
    const defaultRules = DEFAULT_ROLE_RULES[role];
    if (!defaultRules) return;
    setEditedRules(prev => ({
      ...prev,
      [role]: { ...defaultRules }
    }));
  };

  const handleResetAll = () => {
    setShowResetAllConfirm(true);
  };

  const handleConfirmResetAll = async () => {
    setShowResetAllConfirm(false);
    if (!(await guardEdit())) return;
    resetAllRoleRulesToDefaults();
    setEditedRules(prev => ({
      ...DEFAULT_ROLE_RULES,
      ...Object.fromEntries(Object.entries(prev).filter(([k]) => !(k in DEFAULT_ROLE_RULES)))
    }));
  };

  return {
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
  };
}
