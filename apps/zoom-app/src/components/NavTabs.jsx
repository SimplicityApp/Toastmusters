import { memo } from 'react';
import { trackEvent } from '../utils/posthog';
import { useFlag } from '../hooks/useFlag';

export default memo(function NavTabs({ activeTab, onTabChange }) {
  // Agenda, Live, Report: the meeting's own order. The agenda is prepared
  // before the meeting, the timer runs during it, the report is read after —
  // so Live sits in the middle even though it is still the tab the app opens on.
  const tabs = [
    { id: 'agenda', label: 'AGENDA' },
    { id: 'live', label: 'LIVE' },
    { id: 'report', label: 'REPORT' },
  ];
  // The poll comes last, as it does in the meeting: the vote is taken at the end.
  const { enabled: pollsOn } = useFlag('polls');
  if (pollsOn) tabs.push({ id: 'poll', label: 'POLL' });

  const handleTabChange = (tabId) => {
    (window.requestIdleCallback || setTimeout)(() => trackEvent('tab_viewed', {
      tab_name: tabId,
      previous_tab: activeTab
    }));
    onTabChange(tabId);
  };

  return (
    <div className="w-full border-b border-gray-200">
      <nav className="flex" aria-label="Tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => handleTabChange(tab.id)}
            className={`
              flex-1 px-4 py-3 text-sm font-medium text-center
              transition-colors duration-150
              ${
                activeTab === tab.id
                  ? 'text-blue-600 border-b-2 border-blue-600 bg-blue-50'
                  : 'text-gray-500 hover:text-gray-700 hover:bg-gray-50'
              }
            `}
          >
            {tab.label}
          </button>
        ))}
      </nav>
    </div>
  );
});
