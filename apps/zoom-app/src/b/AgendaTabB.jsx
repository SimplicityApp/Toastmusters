import { memo, useMemo } from 'react';
import { AlertTriangle, Check, ClipboardList, GripVertical, Info, Pencil, Plus, Trash2, Upload } from 'lucide-react';
import { DndContext, closestCenter } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { DEFAULT_CUSTOM_RULES, parseEasySpeakText, parseSimpleFormatText, saveTimeInputMode } from '@toastmaster-timer/shared';
import { useTimer } from '../context/TimerContext';
import { useAgendaEditor } from '../hooks/useAgendaEditor';
import ConfirmModal from '../components/ConfirmModal';
import Sheet from './Sheet';
import { CustomTimesPanel } from './TimerPanels';
import { formatThreshold, thresholdsLine } from './format';

const PRIMARY = 'flex items-center justify-center gap-2 rounded-xl bg-blue-600 font-bold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300';
const SECONDARY = 'flex items-center justify-center gap-2 rounded-xl border border-gray-300 bg-white font-semibold text-gray-900 hover:bg-slate-50';

/** One agenda row (board B-G02): drag dots, the name, what the row is set to, and edit / remove on hover. */
function AgendaRow({ item, isActive, needsRole, done, roleOptions, roleRules, onPickRole, onEdit, onDelete, onClick }) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: item.id });
  const rules = roleRules[item.role] || item.rules;
  const roleText = item.role === 'Short Roles' && item.originalShortRole ? `Short Roles - ${item.originalShortRole}` : item.role;

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      data-needs-role={needsRole || undefined}
      className={`group/row flex items-center gap-2.5 border-b border-slate-100 px-2.5 py-2.5 last:border-b-0 ${
        needsRole ? 'border-l-4 border-l-red-500 bg-red-50' : isActive ? 'bg-blue-50' : 'bg-white'
      }`}
    >
      {item.completed ? (
        <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-green-500" aria-label="Done">
          <Check className="h-3.5 w-3.5 text-white" strokeWidth={3} aria-hidden="true" />
        </span>
      ) : (
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label={`Reorder ${item.name}`}
          className="flex-shrink-0 cursor-grab touch-none text-slate-400 hover:text-slate-600 active:cursor-grabbing"
        >
          <GripVertical className="h-5 w-5" aria-hidden="true" />
        </button>
      )}

      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={onClick}
          className="block w-full min-w-0 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          aria-label={needsRole ? `${item.name}: pick a role first` : `Put ${item.name} on the timer`}
        >
          <span className="flex items-center gap-1.5">
            <strong className="truncate text-sm text-gray-900">{item.name}</strong>
            {isActive && !item.completed && (
              <span className="flex-shrink-0 rounded bg-blue-600 px-1.5 py-px text-[10px] font-bold tracking-wide text-white">
                ON THE TIMER
              </span>
            )}
          </span>
          {!needsRole && (
            <span className="block truncate text-xs text-slate-500">
              {roleText}
              {done ? ` · ${done.duration} · ${done.color}` : rules ? ` · ${thresholdsLine(rules)}` : ''}
            </span>
          )}
        </button>
        {needsRole && (
          <>
            <span className="mt-0.5 flex items-start gap-1 text-xs text-red-700">
              <AlertTriangle className="mt-px h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
              {item.role ? `(${item.role}) is not one of your roles` : 'No role given'}
            </span>
            <select
              aria-label={`Pick a role for ${item.name}`}
              value=""
              onChange={(event) => onPickRole(item, event.target.value)}
              className="mt-1 w-full rounded-lg border border-red-300 bg-white px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-red-400"
            >
              <option value="" disabled>
                Pick a role…
              </option>
              {roleOptions.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
          </>
        )}
      </div>

      <div className="flex flex-shrink-0 items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover/row:opacity-100">
        <button type="button" onClick={() => onEdit(item)} aria-label={`Edit ${item.name}`} className="rounded p-1 text-slate-400 hover:text-blue-600">
          <Pencil className="h-4 w-4" aria-hidden="true" />
        </button>
        <button type="button" onClick={() => onDelete(item.id)} aria-label={`Delete ${item.name}`} className="rounded p-1 text-slate-400 hover:text-red-600">
          <Trash2 className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </li>
  );
}

/** How many speakers a paste will add, before it is added. */
function countFound(tab, text, roleOptions) {
  if (!text.trim()) return 0;
  try {
    const found = tab === 'easyspeak' ? parseEasySpeakText(text) : parseSimpleFormatText(text, roleOptions);
    return Array.isArray(found) ? found.length : 0;
  } catch {
    return 0;
  }
}

/**
 * Design B's Agenda tab (boards B-G01 to B-G04): the evening's speakers in
 * order, a paste sheet for EasySpeak or one name per line, and an add / edit
 * sheet. The same agenda, imports and rules as today's tab, from
 * useAgendaEditor; only the look is new.
 */
export default memo(function AgendaTabB({ onSwitchToLive }) {
  const a = useAgendaEditor({ onSwitchToLive });
  const { reports, roleRules } = useTimer();

  // A finished row shows how it went: the newest report for that name and role.
  const doneFor = useMemo(() => {
    const byKey = new Map();
    for (const report of reports) byKey.set(`${report.name}\u0000${report.role}`, report);
    return (item) => (item.completed ? byKey.get(`${item.name}\u0000${item.role}`) : null);
  }, [reports]);

  const openImport = () => {
    a.setImportTab('easyspeak');
    a.setImportText('');
    a.setEasySpeakText('');
    a.setShowImportModal(true);
  };
  const closeImport = () => {
    a.setShowImportModal(false);
    a.setImportText('');
    a.setEasySpeakText('');
    a.setImportTab('easyspeak');
  };
  const openAdd = () => {
    a.setEditItem(null);
    a.setNewSpeakerName('');
    a.setNewSpeakerRole(a.defaultRole);
    a.setCustomRules({ ...DEFAULT_CUSTOM_RULES });
    a.setShowAddModal(true);
  };
  const closeAdd = () => {
    a.setShowAddModal(false);
    a.setEditItem(null);
    a.setNewSpeakerName('');
    a.setNewSpeakerRole(a.defaultRole);
    a.setCustomRules({ ...DEFAULT_CUSTOM_RULES });
  };

  const importText = a.importTab === 'easyspeak' ? a.easySpeakText : a.importText;
  const found = countFound(a.importTab, importText, a.roleOptions);
  const addRules = a.newSpeakerRole && a.newSpeakerRole !== 'Custom' ? roleRules[a.newSpeakerRole] : null;
  const count = a.agenda.length;

  return (
    <div className="flex min-h-full flex-col gap-3.5 px-4 pb-4 pt-2">
      <div className="flex items-center gap-2">
        <h2 className="m-0 flex-1 text-lg font-bold">Today&apos;s agenda</h2>
        {count === 0 ? (
          <span className="text-xs text-slate-400">0 speakers</span>
        ) : (
          <>
            <button type="button" onClick={openImport} aria-label="Paste agenda" className="flex items-center gap-1.5 rounded-lg border border-gray-300 px-2.5 py-1.5 text-[13px] font-semibold hover:bg-slate-50">
              <Upload className="h-3.5 w-3.5" aria-hidden="true" />
              Paste
            </button>
            <button type="button" onClick={openAdd} className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-2.5 py-1.5 text-[13px] font-semibold text-white hover:bg-blue-700">
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              Add
            </button>
          </>
        )}
      </div>

      {count === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-3 text-center">
          <span className="flex h-[84px] w-[84px] items-center justify-center rounded-3xl bg-blue-50">
            <ClipboardList className="h-10 w-10 text-blue-600" strokeWidth={1.8} aria-hidden="true" />
          </span>
          <strong className="text-[17px]">No speakers yet</strong>
          <p className="m-0 text-sm leading-relaxed text-slate-600">
            Add the evening&apos;s speakers once. The timer then loads each one in order, with their role and times.
          </p>
          <div className="mt-2 flex w-full flex-col gap-2">
            <button type="button" onClick={openImport} className={`${PRIMARY} h-[46px] text-[15px]`}>
              <Upload className="h-4 w-4" aria-hidden="true" />
              Paste from EasySpeak
            </button>
            <button type="button" onClick={openAdd} className={`${SECONDARY} h-[46px] text-[15px]`}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              Add a speaker
            </button>
          </div>
        </div>
      ) : (
        <>
          {a.needsRoleCount > 0 && (
            <div role="status" className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-[13px] text-red-800">
              <AlertTriangle className="mt-px h-4 w-4 flex-shrink-0" aria-hidden="true" />
              <span>
                {a.needsRoleCount === 1 ? '1 row needs a role' : `${a.needsRoleCount} rows need a role`}. Nothing was guessed: pick one of
                your roles on {a.needsRoleCount === 1 ? 'the red row' : 'each red row'}.
              </span>
            </div>
          )}
          <DndContext sensors={a.sensors} collisionDetection={closestCenter} onDragEnd={a.handleDragEnd}>
            <SortableContext items={a.agenda.map((item) => item.id)} strategy={verticalListSortingStrategy}>
              <ol aria-label="Agenda" className="m-0 list-none overflow-hidden rounded-xl border border-gray-200 p-0">
                {a.agenda.map((item) => (
                  <AgendaRow
                    key={item.id}
                    item={item}
                    isActive={a.activeSpeakerId === item.id}
                    needsRole={a.needsRole(item)}
                    done={doneFor(item)}
                    roleOptions={a.roleOptions}
                    roleRules={roleRules}
                    onPickRole={a.handlePickRole}
                    onEdit={a.handleEdit}
                    onDelete={a.handleDelete}
                    onClick={() => a.handleSpeakerClick(item)}
                  />
                ))}
              </ol>
            </SortableContext>
          </DndContext>
          <p className="m-0 text-xs leading-relaxed text-slate-500">
            Tap a speaker to put them on the timer. Drag the dots to reorder. Point at a row for edit and remove.
          </p>
          <div className="flex justify-center">
            <button type="button" onClick={a.handleClearAll} className="text-[13px] font-semibold text-red-600 hover:underline">
              Clear the agenda
            </button>
          </div>
        </>
      )}

      {count === 0 && (
        <div className="flex gap-2.5 rounded-xl bg-slate-50 px-3 py-2.5 text-xs leading-relaxed text-slate-600">
          <Info className="mt-px h-4 w-4 flex-shrink-0 text-slate-500" aria-hidden="true" />
          <span>No agenda? You can still type a name straight on the Timer tab.</span>
        </div>
      )}

      <Sheet open={a.showImportModal} onClose={closeImport} title="Paste agenda">
        <div role="tablist" aria-label="Agenda format" className="mb-3 flex gap-0.5 rounded-[9px] bg-slate-100 p-[3px]">
          {[
            ['easyspeak', 'From EasySpeak'],
            ['simple', 'One per line'],
          ].map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={a.importTab === id}
              onClick={() => a.setImportTab(id)}
              className={`flex-1 rounded-[7px] py-1.5 text-[13px] ${a.importTab === id ? 'bg-white font-semibold shadow-sm' : 'text-slate-600'}`}
            >
              {label}
            </button>
          ))}
        </div>
        {a.importTab === 'easyspeak' ? (
          <ol className="mb-2.5 mt-0 list-decimal space-y-0.5 pl-5 text-[13px] text-slate-600">
            <li>Open the meeting in EasySpeak.</li>
            <li>Select the whole agenda and copy it.</li>
            <li>Paste it below. Roles we know get their times.</li>
          </ol>
        ) : (
          <p className="mb-2.5 mt-0 text-[13px] text-slate-600">
            One speaker per line, with the role in brackets as your role list spells it: &ldquo;Sarah Smith (Standard Speech)&rdquo;. A row
            whose role is not in the list stays red for you to pick.
          </p>
        )}
        <textarea
          aria-label={a.importTab === 'easyspeak' ? 'EasySpeak agenda' : 'One speaker per line'}
          value={importText}
          onChange={(event) =>
            a.importTab === 'easyspeak' ? a.setEasySpeakText(event.target.value) : a.setImportText(event.target.value)
          }
          placeholder={a.importTab === 'easyspeak' ? 'Paste the EasySpeak agenda here…' : 'John Doe (Ice Breaker)\nSarah Smith (Standard Speech)'}
          className="h-40 w-full rounded-xl border border-gray-300 p-2.5 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <p className="mb-0 mt-2 text-xs text-slate-500">
          {found > 0
            ? `Found ${found} ${found === 1 ? 'speaker' : 'speakers'}. Rows we can't match stay red for you to pick.`
            : 'Nothing found yet.'}
        </p>
        <div className="mt-3 flex gap-2">
          <button type="button" onClick={closeImport} className={`${SECONDARY} h-11 flex-1 text-sm`}>
            Cancel
          </button>
          <button
            type="button"
            disabled={!importText.trim()}
            onClick={a.importTab === 'easyspeak' ? a.handleEasySpeakImport : a.handleSimpleImport}
            className={`${PRIMARY} h-11 flex-1 text-sm`}
          >
            {found > 0 ? `Add ${found} ${found === 1 ? 'speaker' : 'speakers'}` : 'Add speakers'}
          </button>
        </div>
      </Sheet>

      <Sheet open={a.showAddModal} onClose={closeAdd} title={a.editItem ? 'Edit speaker' : 'Add speaker'}>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-[13px] font-semibold text-slate-700">
            Name
            <input
              value={a.newSpeakerName}
              onChange={(event) => a.setNewSpeakerName(event.target.value)}
              placeholder="Speaker's name"
              className="h-10 rounded-lg border border-gray-300 px-2.5 text-sm font-normal text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </label>
          <label className="flex flex-col gap-1 text-[13px] font-semibold text-slate-700">
            Role
            <select
              value={a.newSpeakerRole}
              onChange={(event) => a.setNewSpeakerRole(event.target.value)}
              className="h-10 rounded-lg border border-gray-300 bg-white px-2 text-sm font-normal text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {!a.newSpeakerRole && (
                <option value="" disabled>
                  Pick a role…
                </option>
              )}
              {a.roleOptions.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
          </label>
          {addRules && (
            <div className="flex flex-wrap gap-1.5 text-xs">
              <span className="rounded-md bg-green-50 px-2 py-1 text-green-700">Green {formatThreshold(addRules.green)}</span>
              <span className="rounded-md bg-yellow-50 px-2 py-1 text-yellow-700">Yellow {formatThreshold(addRules.yellow)}</span>
              <span className="rounded-md bg-red-50 px-2 py-1 text-red-700">Red {formatThreshold(addRules.red)}</span>
              <span className="px-1 py-1 text-slate-500">Pick Custom to set your own</span>
            </div>
          )}
          {a.newSpeakerRole === 'Custom' && (
            <CustomTimesPanel
              rules={a.customRules}
              mode={a.timeInputMode}
              onModeChange={(mode) => {
                saveTimeInputMode(mode);
                a.setTimeInputMode(mode);
              }}
              onChange={a.handleCustomRuleChange}
            />
          )}
        </div>
        <div className="mt-4 flex gap-2">
          <button type="button" onClick={closeAdd} className={`${SECONDARY} h-11 flex-1 text-sm`}>
            Cancel
          </button>
          <button
            type="button"
            onClick={a.editItem ? a.handleUpdate : a.handleAdd}
            disabled={!a.newSpeakerRole || !a.newSpeakerName.trim()}
            className={`${PRIMARY} h-11 flex-1 text-sm`}
          >
            {a.editItem ? 'Save' : 'Add to agenda'}
          </button>
        </div>
      </Sheet>

      <ConfirmModal
        isOpen={a.showDeleteConfirm}
        title="Remove speaker"
        message="Remove this speaker from the agenda?"
        confirmText="Remove"
        cancelText="Cancel"
        onConfirm={a.handleConfirmDelete}
        onCancel={() => {
          a.setShowDeleteConfirm(false);
          a.setDeleteItemId(null);
        }}
      />
      <ConfirmModal
        isOpen={a.showClearAllConfirm}
        title="Clear the agenda"
        message="Remove every speaker from today's agenda? This cannot be undone."
        confirmText="Clear the agenda"
        cancelText="Cancel"
        onConfirm={a.handleConfirmClearAll}
        onCancel={() => a.setShowClearAllConfirm(false)}
      />
    </div>
  );
});
