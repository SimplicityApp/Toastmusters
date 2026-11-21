import { useState } from 'react';
import { useTimer } from '../context/TimerContext';
import { useToast } from '../context/ToastContext';
import { trackEvent } from '../utils/posthog';
import { KeyboardSensor, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { arrayMove, sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { DEFAULT_ROLE_RULES, DEFAULT_CUSTOM_RULES, loadTimeInputMode, agendaItemNeedsRole } from '@toastmaster-timer/shared';

/**
 * Everything the Agenda tab does, apart from how it looks: importing an
 * EasySpeak or one-per-line agenda, adding, editing, reordering and removing
 * rows, picking a role for a row that needs one, and loading a row onto the
 * timer.
 *
 * Lifted out of AgendaTab unchanged so design B's Agenda tab (plan 13) draws
 * the same agenda without a second copy of the logic.
 *
 * @param {{onSwitchToLive?: () => void}} options
 * @returns {Object} state and handlers for an agenda view
 */
export function useAgendaEditor({ onSwitchToLive } = {}) {
  const {
    agenda,
    activeSpeakerId,
    addToAgenda,
    removeFromAgenda,
    reorderAgenda,
    updateAgendaItem,
    loadSpeakerFromAgenda,
    importBulkSpeakers,
    importEasySpeakSpeakers,
    clearAllAgenda,
    roleRules,
    roleOptions,
  } = useTimer();
  const { showToast } = useToast();
  // Standard Speech unless it was removed in Edit Rules; then the first listed
  // role, so the picker never shows one role while saving another.
  const defaultRole = roleOptions.includes('Standard Speech') ? 'Standard Speech' : roleOptions[0] || 'Standard Speech';
  const needsRole = (item) => agendaItemNeedsRole(item, roleOptions);
  const needsRoleCount = agenda.filter(needsRole).length;

  const [showImportModal, setShowImportModal] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [importTab, setImportTab] = useState('easyspeak'); // 'simple' | 'easyspeak'
  const [importText, setImportText] = useState('');
  const [easySpeakText, setEasySpeakText] = useState('');
  const [editItem, setEditItem] = useState(null);
  const [newSpeakerName, setNewSpeakerName] = useState('');
  const [newSpeakerRole, setNewSpeakerRole] = useState(defaultRole);
  const [customRules, setCustomRules] = useState({ ...DEFAULT_CUSTOM_RULES });
  const [timeInputMode, setTimeInputMode] = useState(loadTimeInputMode);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteItemId, setDeleteItemId] = useState(null);
  const [showClearAllConfirm, setShowClearAllConfirm] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragEnd = (event) => {
    const { active, over } = event;

    if (active.id !== over.id) {
      const oldIndex = agenda.findIndex((item) => item.id === active.id);
      const newIndex = agenda.findIndex((item) => item.id === over.id);
      const newOrder = arrayMove(agenda, oldIndex, newIndex);
      reorderAgenda(newOrder);
      
      // Track agenda reordered
      const movedItem = agenda[oldIndex];
      trackEvent('agenda_reordered', {
        speaker_name: movedItem?.name || 'Unnamed',
        old_index: oldIndex,
        new_index: newIndex
      });
    }
  };

  const handleSimpleImport = () => {
    if (importText.trim()) {
      const { count, needsRole: unmatched } = importBulkSpeakers(importText);
      if (unmatched > 0) {
        showToast(`Imported ${count} speaker(s). ${unmatched} need${unmatched === 1 ? 's' : ''} a role`, 'warning');
      } else {
        showToast(`Imported ${count} speaker(s)`, 'success');
      }
      setImportText('');
      setShowImportModal(false);
    }
  };

  const handleEasySpeakImport = () => {
    if (easySpeakText.trim()) {
      const count = importEasySpeakSpeakers(easySpeakText);
      showToast(`Imported ${count} speaker(s)`, 'success');
      setEasySpeakText('');
      setShowImportModal(false);
    }
  };

  const handleAdd = () => {
    if (newSpeakerName.trim()) {
      const speakerData = {
        name: newSpeakerName.trim(),
        role: newSpeakerRole,
      };
      // If Custom role, include custom rules
      if (newSpeakerRole === 'Custom') {
        speakerData.rules = customRules;
      }
      addToAgenda(speakerData);
      setNewSpeakerName('');
      setNewSpeakerRole(defaultRole);
      setCustomRules({ ...DEFAULT_CUSTOM_RULES });
      setShowAddModal(false);
    }
  };

  const handleEdit = (item) => {
    setEditItem(item);
    setNewSpeakerName(item.name);
    // A role that isn't listed can't be shown by the select; start on "Pick a role…".
    setNewSpeakerRole(needsRole(item) ? '' : item.role);
    // If item has custom rules, load them (merge so missing graceAfterRed is filled)
    if (item.role === 'Custom' && item.rules) {
      setCustomRules({ ...DEFAULT_CUSTOM_RULES, ...item.rules });
    } else {
      setCustomRules({ ...DEFAULT_CUSTOM_RULES });
    }
    setShowAddModal(true);
  };

  const handleUpdate = () => {
    if (editItem && newSpeakerName.trim() && newSpeakerRole) {
      const speakerData = {
        name: newSpeakerName.trim(),
        role: newSpeakerRole,
      };
      // If Custom role, include custom rules
      if (newSpeakerRole === 'Custom') {
        speakerData.rules = customRules;
      }
      // Update in place so the speaker keeps their position in the agenda
      updateAgendaItem(editItem.id, speakerData);
      setEditItem(null);
      setNewSpeakerName('');
      setNewSpeakerRole(defaultRole);
      setCustomRules({ ...DEFAULT_CUSTOM_RULES });
      setShowAddModal(false);
    }
  };

  const handlePickRole = (item, role) => {
    if (!role) return;
    updateAgendaItem(item.id, { name: item.name, role });
    trackEvent('agenda_role_picked', { is_custom: !(role in DEFAULT_ROLE_RULES) });
  };

  const handleDelete = (id) => {
    setDeleteItemId(id);
    setShowDeleteConfirm(true);
  };

  const handleConfirmDelete = () => {
    if (deleteItemId) {
      removeFromAgenda(deleteItemId);
    }
    setShowDeleteConfirm(false);
    setDeleteItemId(null);
  };

  const handleClearAll = () => {
    setShowClearAllConfirm(true);
  };

  const handleConfirmClearAll = () => {
    clearAllAgenda();
    setShowClearAllConfirm(false);
  };

  // Helper to format seconds as readable time
  const formatTimeReadable = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    if (mins === 0) {
      return `${secs} second${secs !== 1 ? 's' : ''}`;
    }
    if (secs === 0) {
      return `${mins} minute${mins !== 1 ? 's' : ''}`;
    }
    return `${mins} min ${secs} sec`;
  };

  // Get explanation text for each role
  const getRoleExplanation = (role) => {
    const rules = roleRules[role] || DEFAULT_ROLE_RULES[role] || DEFAULT_ROLE_RULES['Standard Speech'];
    return `Green: ${formatTimeReadable(rules.green)}, Yellow: ${formatTimeReadable(rules.yellow)}, Red: ${formatTimeReadable(rules.red)}`;
  };

  const handleCustomRuleChange = (field, value) => {
    setCustomRules(prev => ({ ...prev, [field]: value }));
  };

  const handleSpeakerClick = (item) => {
    // Without a role there are no rules to time with; the Live tab would quietly
    // fall back to the default role. Ask instead.
    if (needsRole(item)) {
      showToast(`Pick a role for ${item.name} first`, 'warning');
      return;
    }
    loadSpeakerFromAgenda(item.id);
    // Track speaker loaded from agenda
    trackEvent('speaker_loaded_from_agenda', {
      speaker_name: item.name || 'Unnamed',
      role: item.role
    });
    if (onSwitchToLive) {
      onSwitchToLive();
    }
  };

  return {
    agenda,
    activeSpeakerId,
    roleOptions,
    defaultRole,
    needsRole,
    needsRoleCount,
    showImportModal,
    setShowImportModal,
    showAddModal,
    setShowAddModal,
    importTab,
    setImportTab,
    importText,
    setImportText,
    easySpeakText,
    setEasySpeakText,
    editItem,
    setEditItem,
    newSpeakerName,
    setNewSpeakerName,
    newSpeakerRole,
    setNewSpeakerRole,
    customRules,
    setCustomRules,
    timeInputMode,
    setTimeInputMode,
    showDeleteConfirm,
    setShowDeleteConfirm,
    setDeleteItemId,
    showClearAllConfirm,
    setShowClearAllConfirm,
    sensors,
    handleDragEnd,
    handleSimpleImport,
    handleEasySpeakImport,
    handleAdd,
    handleEdit,
    handleUpdate,
    handlePickRole,
    handleDelete,
    handleConfirmDelete,
    handleClearAll,
    handleConfirmClearAll,
    getRoleExplanation,
    handleCustomRuleChange,
    handleSpeakerClick,
  };
}
