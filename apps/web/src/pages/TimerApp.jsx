import { useState, useEffect, lazy, Suspense } from 'react'
import { Link } from 'react-router-dom'
import { PanelLeftClose, PanelRightOpen, Square } from 'lucide-react'
import { TimerProvider, useTimer, useTimerTick } from '../context/TimerContext'
import { resetPageBackground, setPageBackgroundFromStatus } from '../utils/pageBackground'
import { ToastProvider } from '../context/ToastContext'
import NavTabs from '../components/NavTabs'
import LiveTab from '../components/LiveTab'
const AgendaTab = lazy(() => import('../components/AgendaTab'))
import ReportTab from '../components/ReportTab'
import Footer from '../components/Footer'
import PeriodicPrompts from '../components/PeriodicPrompts'
import AccountMenu from '../components/AccountMenu'
import '../App.css'

function MinimizedFloatingButtons({ onRestore }) {
  const { isRunning } = useTimerTick()
  const { stopTimer } = useTimer()

  const handleStop = () => {
    stopTimer()
    onRestore()
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 flex items-center gap-2">
      {isRunning && (
        <button
          onClick={handleStop}
          className="p-3 rounded-full bg-red-500 hover:bg-red-600 text-white shadow-lg transition-colors"
          title="Stop and show panel"
        >
          <Square className="h-8 w-8" />
        </button>
      )}
      <button
        onClick={onRestore}
        className="p-3 rounded-full bg-white/95 shadow-lg border border-gray-200 hover:bg-gray-50 transition-colors"
        title="Show control panel"
      >
        <PanelRightOpen className="h-8 w-8 text-gray-700" />
      </button>
    </div>
  )
}

function TimerAppContent() {
  const [activeTab, setActiveTab] = useState('live')
  const [panelMinimized, setPanelMinimized] = useState(false)

  if (panelMinimized) {
    return <MinimizedFloatingButtons onRestore={() => setPanelMinimized(false)} />
  }

  return (
    <div className="app-container w-full h-screen flex flex-col bg-white">
      <div className="flex items-center justify-between px-2 py-1 border-b border-gray-200 bg-white/90">
        <Link to="/" className="text-sm text-gray-500 hover:text-gray-700">← Back to home</Link>
        <div className="flex items-center gap-1">
          <AccountMenu compact />
          <button
            onClick={() => setPanelMinimized(true)}
          className="p-1.5 rounded text-gray-500 hover:text-gray-700 hover:bg-gray-100"
          title="Minimize panel"
        >
          <PanelLeftClose className="h-5 w-5" />
          </button>
        </div>
      </div>
      <NavTabs activeTab={activeTab} onTabChange={setActiveTab} />
      <div className="flex-1 overflow-y-auto">
        {activeTab === 'live' && <LiveTab onTimerStart={() => setPanelMinimized(true)} />}
        {activeTab === 'agenda' && <Suspense fallback={null}><AgendaTab onSwitchToLive={() => setActiveTab('live')} /></Suspense>}
        {activeTab === 'report' && <ReportTab />}
      </div>
      <Footer />
      {/* Only while the panel is up: minimized means the window may be shared
          with the meeting, and a modal would land on everyone's screen. */}
      <PeriodicPrompts />
    </div>
  )
}

export default function TimerApp() {
  useEffect(() => {
    setPageBackgroundFromStatus('blue')
    return () => resetPageBackground()
  }, [])
  return (
    <ToastProvider>
      <TimerProvider>
        <TimerAppContent />
      </TimerProvider>
    </ToastProvider>
  )
}
