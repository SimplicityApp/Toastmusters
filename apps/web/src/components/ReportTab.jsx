import { memo } from 'react';
import { useTimer } from '../context/TimerContext';
import { useToast } from '../context/ToastContext';
import { Copy, Check, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import BrandedReportHeader from '@toastmaster-timer/ui/BrandedReportHeader';
import ConfirmModal from './ConfirmModal';
import { useClub } from '../hooks/useClub';

function ColorDot({ color }) {
  const colorClasses = { green: 'bg-green-500', yellow: 'bg-yellow-500', red: 'bg-red-500', blue: 'bg-blue-500' };
  return <div className={`w-4 h-4 rounded-full ${colorClasses[color] || 'bg-gray-300'} inline-block mr-2`} />;
}

export default memo(function ReportTab() {
  const { reports, clearAllReports } = useTimer();
  const { showToast } = useToast();
  // The club's header, on a surface free never touches. With no club, or with
  // "Show on reports" off, nothing renders and the tab is what it always was.
  const { kit } = useClub();
  const [copied, setCopied] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [showClipboardFallback, setShowClipboardFallback] = useState(false);
  const [clipboardText, setClipboardText] = useState('');

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
  const handleConfirmClear = () => { clearAllReports(); setShowClearConfirm(false); };

  return (
    <div className="p-4 space-y-4">
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
                    <tr key={index} className="hover:bg-gray-50">
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
