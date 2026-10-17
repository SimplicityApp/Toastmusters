import { useState, lazy, Suspense } from 'react';
import { TimerProvider } from './context/TimerContext';
import { ToastProvider } from './context/ToastContext';
import NavTabs from './components/NavTabs';
import Footer from './components/Footer';
import PeriodicPrompts from './components/PeriodicPrompts';
import ContactCapture from './components/ContactCapture';
import ZoomConnectionNotice from './components/ZoomConnectionNotice';
import ClubStatusBanner from './components/ClubStatusBanner';
import './App.css';

const LiveTab = lazy(() => import('./components/LiveTab'));
const AgendaTab = lazy(() => import('./components/AgendaTab'));
const ReportTab = lazy(() => import('./components/ReportTab'));

function App() {
  const [activeTab, setActiveTab] = useState('live');

  return (
    <ToastProvider>
      <TimerProvider>
        <div className="app-container w-full h-screen flex flex-col bg-white">
          <ZoomConnectionNotice />
          {/* Above the tabs, ahead of everything: the week of warning a club
              gets before it loses Pro has to be seen by whoever is timing, who
              is rarely whoever pays. */}
          <ClubStatusBanner />
          <NavTabs activeTab={activeTab} onTabChange={setActiveTab} />

          <Suspense fallback={
            <div style={{display:'flex',alignItems:'center',justifyContent:'center',height:'100%',flex:1}}>
              <div style={{width:32,height:32,border:'3px solid #e5e7eb',borderTopColor:'#3b82f6',borderRadius:'50%',animation:'spin 0.6s linear infinite'}} />
              <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
            </div>
          }>
            <div className="flex-1 overflow-y-auto">
              {activeTab === 'live' && <LiveTab />}
              {activeTab === 'agenda' && <AgendaTab onSwitchToLive={() => setActiveTab('live')} />}
              {activeTab === 'report' && <ReportTab />}
            </div>
          </Suspense>

          <Footer />
          <PeriodicPrompts />
          <ContactCapture />
        </div>
      </TimerProvider>
    </ToastProvider>
  );
}

export default App;
