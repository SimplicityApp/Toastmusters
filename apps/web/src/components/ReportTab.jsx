import { memo } from 'react';
import { useTimer } from '../context/TimerContext';
import { useToast } from '../context/ToastContext';
import { Copy, Check, Trash2, X, History, CloudOff, ChevronLeft } from 'lucide-react';
import { useState } from 'react';
import BrandedReportHeader from '@toastmaster-timer/ui/BrandedReportHeader';
import ReportHistoryList from '@toastmaster-timer/ui/ReportHistoryList';
import { fetchHistory, fetchMeeting } from '@toastmaster-timer/shared';
import ConfirmModal from './ConfirmModal';
import { useClub, useOutboxPending } from '../hooks/useClub';
import { trackEvent } from '../utils/posthog';

function ColorDot({ color }) {
  const colorClasses = { green: 'bg-green-500', yellow: 'bg-yellow-500', red: 'bg-red-500', blue: 'bg-blue-500' };
  return <div className={`w-4 h-4 rounded-full ${colorClasses[color] || 'bg-gray-300'} inline-block mr-2`} />;
}

const UNREACHABLE = 'Could not reach the club just now. Nothing is lost — this device keeps its own copy.';

export default memo(function ReportTab() {
  const { reports, clearAllReports } = useTimer();
  const { showToast } = useToast();
  // The club's header, on a surface free never touches. With no club, or with
  // "Show on reports" off, nothing renders and the tab is what it always was.
  const { club, kit, clubName } = useClub();
  // Outbox emptiness, not the last request's result: a device that went offline
  // mid-meeting must show work pending rather than claim it is saved.
  const pending = useOutboxPending();
  const [copied, setCopied] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [showClipboardFallback, setShowClipboardFallback] = useState(false);
  const [clipboardText, setClipboardText] = useState('');
  const [history, setHistory] = useState(null);
  const [openMeeting, setOpenMeeting] = useState(null);

  // A lapsed club keeps its cached record (the device still knows which club to
  // re-check) but stops archiving, so the strip and History go with it.
  const archiving = Boolean(club?.entitled);
  const archiveName = clubName || club?.club?.name || 'your club';

  const copyToClipboard = async () => {
    if (reports.length === 0) { showToast('No reports to copy', 'warning'); return; }
    const header = 'Name\tRole\tDuration\tStatus\tOver time\tComments\n';
    const rows = reports.map(r => `${r.name}\t${r.role}\t${r.duration}\t${r.color}\t${r.disqualified ? 'Yes' : ''}\t${r.comments || ''}`).join('\n');
    const text = header + rows;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
        showToast('Copied to clipboard', 'success');
      } else {
        setClipboardText(text);
        setShowClipboardFallback(true);
      }
    } catch (err) {
      setClipboardText(text);
      setShowClipboardFallback(true);
    }
  };

  const handleClear = () => { if (reports.length > 0) setShowClearConfirm(true); };
  // Deliberately local only: the archive is the club's record of the evening
  // and clearing this device's scratch list must not reach into it.
  const handleConfirmClear = () => { clearAllReports(); setShowClearConfirm(false); };

  const openHistory = async () => {
    setOpenMeeting(null);
    setHistory({ loading: true, error: null, meetings: [] });
    const result = await fetchHistory();
    if (!result.ok) { setHistory({ loading: false, error: UNREACHABLE, meetings: [] }); return; }
    setHistory({ loading: false, error: null, meetings: result.meetings });
    trackEvent('report_history_viewed', { meetings: result.meetings.length, surface: 'web' });
  };

  const selectMeeting = async (meetingId) => {
    setOpenMeeting({ loading: true, error: null, meeting: null });
    const result = await fetchMeeting(meetingId);
    if (!result.ok) { setOpenMeeting({ loading: false, error: UNREACHABLE, meeting: null }); return; }
    setOpenMeeting({ loading: false, error: null, meeting: result.meeting });
  };

  const speechRows = (rows) => (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr className="bg-gray-100">
          <th className="border border-gray-300 px-2 py-2 text-left font-semibold text-gray-700 text-xs">Name</th>
          <th className="border border-gray-300 px-2 py-2 text-left font-semibold text-gray-700 text-xs">Role</th>
          <th className="border border-gray-300 px-2 py-2 text-left font-semibold text-gray-700 text-xs">Time</th>
          <th className="border border-gray-300 px-2 py-2 text-left font-semibold text-gray-700 text-xs">Comments</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((speech) => (
          <tr key={speech.speechId}>
            <td className="border border-gray-300 px-2 py-2 text-gray-900 text-xs">{speech.name}</td>
            <td className="border border-gray-300 px-2 py-2 text-gray-700 text-xs">{speech.role}</td>
            <td className="border border-gray-300 px-2 py-2 text-gray-700 font-mono text-xs">{speech.duration}</td>
            <td className="border border-gray-300 px-2 py-2 text-gray-700 text-xs">{speech.comments || ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <div className="p-4 space-y-4">
      {archiving && (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
          <span className="flex items-center gap-2 text-xs text-gray-600 min-w-0" data-testid="club-archive-indicator">
            {pending > 0 ? (
              <><CloudOff className="h-4 w-4 flex-shrink-0" /><span className="truncate">{pending} {pending === 1 ? 'speech' : 'speeches'} waiting to upload</span></>
            ) : (
              <><Check className="h-4 w-4 flex-shrink-0 text-green-600" /><span className="truncate">Saved to {archiveName}</span></>
            )}
          </span>
          <button onClick={openHistory} className="flex items-center gap-1 text-xs font-semibold text-blue-600 hover:text-blue-700 flex-shrink-0">
            <History className="h-4 w-4" /> History
          </button>
        </div>
      )}
      {reports.length === 0 ? (
        <div className="text-center py-8 text-gray-500">No reports yet. Complete speeches in the LIVE tab to generate reports.</div>
      ) : (
        <>
          {kit?.showOnReports && (
            <BrandedReportHeader clubName={kit.name} primaryColor={kit.primaryColor} logoUrl={kit.logoUrl} />
          )}
          <div className="overflow-x-auto -mx-4">
            <div className="inline-block min-w-full align-middle">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="bg-gray-100">
                    <th className="border border-gray-300 px-2 py-2 text-left font-semibold text-gray-700 text-xs">Name</th>
                    <th className="border border-gray-300 px-2 py-2 text-left font-semibold text-gray-700 text-xs">Role</th>
                    <th className="border border-gray-300 px-2 py-2 text-left font-semibold text-gray-700 text-xs">Time</th>
                    <th className="border border-gray-300 px-2 py-2 text-left font-semibold text-gray-700 text-xs">Status</th>
                    <th className="border border-gray-300 px-2 py-2 text-left font-semibold text-gray-700 text-xs">Over time</th>
                    <th className="border border-gray-300 px-2 py-2 text-left font-semibold text-gray-700 text-xs">Comments</th>
                  </tr>
                </thead>
                <tbody>
                  {reports.map((report, index) => (
                    <tr key={report.speechId || index} className="hover:bg-gray-50">
                      <td className="border border-gray-300 px-2 py-2 text-gray-900 text-xs">{report.name}</td>
                      <td className="border border-gray-300 px-2 py-2 text-gray-700 text-xs">{report.role}</td>
                      <td className="border border-gray-300 px-2 py-2 text-gray-700 font-mono text-xs">{report.duration}</td>
                      <td className="border border-gray-300 px-2 py-2 text-gray-700"><div className="flex items-center"><ColorDot color={report.color} /><span className="capitalize text-xs">{report.color}</span></div></td>
                      <td className="border border-gray-300 px-2 py-2 text-gray-700 text-xs">{report.disqualified ? 'Yes' : ''}</td>
                      <td className="border border-gray-300 px-2 py-2 text-gray-700 text-xs">{report.comments || ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={copyToClipboard} className="flex-1 bg-blue-500 hover:bg-blue-600 text-white font-semibold py-3 px-4 rounded-lg flex items-center justify-center gap-2">
              {copied ? <><Check className="h-5 w-5" /> Copied!</> : <><Copy className="h-5 w-5" /> Copy Report to Clipboard</>}
            </button>
            <button onClick={handleClear} className="bg-red-500 hover:bg-red-600 text-white font-semibold py-3 px-4 rounded-lg flex items-center justify-center gap-2"><Trash2 className="h-5 w-5" /> Clear</button>
          </div>
        </>
      )}
      <ConfirmModal isOpen={showClearConfirm} title="Clear All Reports" message="Are you sure you want to clear all reports? This action cannot be undone." confirmText="Clear All" cancelText="Cancel" onConfirm={handleConfirmClear} onCancel={() => setShowClearConfirm(false)} />
      {history && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto" data-testid="report-history-modal">
            <div className="flex justify-between items-center mb-4 gap-2">
              {openMeeting ? (
                <button onClick={() => setOpenMeeting(null)} className="flex items-center gap-1 text-sm font-semibold text-blue-600 hover:text-blue-700">
                  <ChevronLeft className="h-4 w-4" /> All meetings
                </button>
              ) : (
                <h3 className="text-lg font-semibold truncate">{archiveName} history</h3>
              )}
              <button onClick={() => { setHistory(null); setOpenMeeting(null); }} className="text-gray-400 hover:text-gray-600" aria-label="Close history"><X className="h-5 w-5" /></button>
            </div>
            {openMeeting ? (
              openMeeting.loading ? (
                <p className="text-center text-sm text-gray-500 py-8">Loading the meeting…</p>
              ) : openMeeting.error ? (
                <p className="text-center text-sm text-gray-500 py-8">{openMeeting.error}</p>
              ) : (
                <>
                  {kit && <BrandedReportHeader clubName={kit.name} primaryColor={kit.primaryColor} logoUrl={kit.logoUrl} date={openMeeting.meeting?.date} />}
                  <div className="mt-3 overflow-x-auto">{speechRows(openMeeting.meeting?.speeches ?? [])}</div>
                </>
              )
            ) : (
              <ReportHistoryList
                meetings={history.meetings}
                loading={history.loading}
                error={history.error}
                onSelect={selectMeeting}
                primaryColor={kit?.primaryColor}
              />
            )}
          </div>
        </div>
      )}
      {showClipboardFallback && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-semibold">Copy Report Data</h3>
              <button onClick={() => { setShowClipboardFallback(false); setClipboardText(''); }} className="text-gray-400 hover:text-gray-600"><X className="h-5 w-5" /></button>
            </div>
            <p className="text-sm text-gray-600 mb-4">Clipboard access is not available. Please manually copy the text below:</p>
            <textarea value={clipboardText} readOnly className="w-full h-64 p-3 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm" onClick={(e) => e.target.select()} />
            <div className="flex gap-2 mt-4">
              <button onClick={() => { setShowClipboardFallback(false); setClipboardText(''); }} className="flex-1 bg-gray-300 hover:bg-gray-400 text-gray-800 font-semibold py-2 px-4 rounded-lg">Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});
