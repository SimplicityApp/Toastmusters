import { lazy, Suspense, useState } from 'react';
import ZoomConnectionNotice from '../components/ZoomConnectionNotice';
import ClubStatusBanner from '../components/ClubStatusBanner';
import AnnouncementBanner from '../components/AnnouncementBanner';
import PeriodicPrompts from '../components/PeriodicPrompts';
import TimerSounds from '../components/TimerSounds';
import ContactCapture from '../components/ContactCapture';
import TopBar from './TopBar';

const TimerTab = lazy(() => import('./TimerTab'));
const AgendaTabB = lazy(() => import('./AgendaTabB'));
const ReportTabB = lazy(() => import('./ReportTabB'));
const RulesSheet = lazy(() => import('./RulesSheet'));

function TabFallback() {
  return (
    <div className="flex flex-1 items-center justify-center py-16">
      <div className="h-8 w-8 animate-spin rounded-full border-[3px] border-gray-200 border-t-blue-500" />
    </div>
  );
}

/**
 * Design B's panel (plan 13): notices on top, then the Agenda / Timer / Report
 * switch with the Pro chip and the ⋯ menu, then the tab. No footer: what it
 * held moved into the chip and the menu, which is what keeps the Timer tab's
 * Start button high in a 400px panel.
 */
export default function NewLookShell() {
  const [activeTab, setActiveTab] = useState('live');
  const [showRules, setShowRules] = useState(false);
  // "Clear the timer from my video" from the ⋯ menu. The clear belongs to the
  // Timer tab, which owns the video, so the menu switches there and the tab
  // runs it once for every bump of this counter.
  const [clearRequest, setClearRequest] = useState(0);

  const handleClearVideo = () => {
    setActiveTab('live');
    setClearRequest((count) => count + 1);
  };

  return (
    <div className="app-container flex h-screen w-full flex-col bg-white" data-look="b">
      <ZoomConnectionNotice />
      <ClubStatusBanner />
      <AnnouncementBanner />
      <TopBar
        activeTab={activeTab}
        onTabChange={setActiveTab}
        onClearVideo={handleClearVideo}
        onOpenRules={() => setShowRules(true)}
      />

      <Suspense fallback={<TabFallback />}>
        <div className="flex-1 overflow-y-auto">
          {activeTab === 'live' && (
            <TimerTab
              clearRequest={clearRequest}
              onGoToAgenda={() => setActiveTab('agenda')}
              onOpenRules={() => setShowRules(true)}
            />
          )}
          {activeTab === 'agenda' && <AgendaTabB onSwitchToLive={() => setActiveTab('live')} />}
          {activeTab === 'report' && <ReportTabB onGoToTimer={() => setActiveTab('live')} />}
        </div>
      </Suspense>

      {/* Mounted only while open, as the old dialog was, so each open starts
          from the rules as they are now. */}
      {showRules && (
        <Suspense fallback={null}>
          <RulesSheet open={showRules} onClose={() => setShowRules(false)} />
        </Suspense>
      )}
      <PeriodicPrompts />
      <TimerSounds />
      <ContactCapture />
    </div>
  );
}
