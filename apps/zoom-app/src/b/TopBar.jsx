import { memo } from 'react';
import { trackEvent } from '../utils/posthog';
import ProChip from './ProChip';
import MoreMenu from './MoreMenu';

// Agenda, Timer, Report: the meeting's own order. The ids stay what NavTabs
// sends to PostHog ('live' for the timer), so tab_viewed compares across looks.
export const TABS = Object.freeze([
  { id: 'agenda', label: 'Agenda' },
  { id: 'live', label: 'Timer' },
  { id: 'report', label: 'Report' },
]);

/**
 * Design B's top row (the BTop board): the Agenda / Timer / Report switch, the
 * Pro chip and the ⋯ menu, on one line at 360px. The switch takes whatever the
 * chip and the menu leave, so nothing wraps.
 *
 * @param {{
 *   activeTab: string,
 *   onTabChange: (id: string) => void,
 *   onClearVideo: () => void,
 *   onOpenRules: () => void,
 * }} props
 */
export default memo(function TopBar({ activeTab, onTabChange, onClearVideo, onOpenRules }) {
  const select = (id) => {
    if (id === activeTab) return;
    (window.requestIdleCallback || setTimeout)(() =>
      trackEvent('tab_viewed', { tab_name: id, previous_tab: activeTab, look: 'b' })
    );
    onTabChange(id);
  };

  return (
    <div className="flex items-center gap-1 px-3 py-2">
      <nav aria-label="Sections" className="flex min-w-0 flex-1 gap-0.5 rounded-[9px] bg-slate-100 p-[3px]">
        {TABS.map((tab) => {
          const active = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => select(tab.id)}
              aria-current={active ? 'page' : undefined}
              className={`min-w-0 flex-1 truncate rounded-[7px] py-1.5 text-center text-[13px] transition-colors ${
                active ? 'bg-white font-semibold text-gray-900 shadow-[0_1px_2px_rgba(0,0,0,0.08)]' : 'text-slate-600 hover:text-gray-900'
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </nav>
      <ProChip />
      <MoreMenu onClearVideo={onClearVideo} onOpenRules={onOpenRules} />
    </div>
  );
});
