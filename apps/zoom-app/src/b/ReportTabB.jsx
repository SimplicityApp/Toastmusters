import { lazy, memo, Suspense, useState } from 'react';
import { Check, ChevronLeft, CloudOff, Copy, FileText, History, Share2, Sparkles, Trash2 } from 'lucide-react';
import BrandedReportHeader from '@toastmaster-timer/ui/BrandedReportHeader';
import ReportHistoryList from '@toastmaster-timer/ui/ReportHistoryList';
import ShareStep from '@toastmaster-timer/ui/ShareStep';
import { useReportView } from '../hooks/useReportView';
import { useEntitlement } from '../hooks/useEntitlement';
import { useFlag } from '../hooks/useFlag';
import ConfirmModal from '../components/ConfirmModal';
import Sheet from './Sheet';

const UpgradeModal = lazy(() => import('../components/UpgradeModal'));

const DOT = { blue: 'bg-[#4f86f7]', green: 'bg-green-500', yellow: 'bg-yellow-400', red: 'bg-red-500' };

/** One timed speech (board B-R02): colour, who and what, the time and how it ended. */
function SpeechRow({ speech }) {
  return (
    <li className="flex items-center gap-2.5 border-b border-slate-100 px-3 py-2.5 last:border-b-0">
      <span aria-hidden="true" className={`h-3 w-3 flex-shrink-0 rounded-full ${DOT[speech.color] || 'bg-slate-300'}`} />
      <span className="min-w-0 flex-1">
        <strong className="block truncate text-sm text-gray-900">{speech.name || 'Unnamed'}</strong>
        <span className="block truncate text-xs text-slate-500">
          {speech.role}
          {speech.comments ? (
            <>
              {' · '}
              <em>&ldquo;{speech.comments}&rdquo;</em>
            </>
          ) : null}
        </span>
      </span>
      <span className="flex-shrink-0 text-right">
        <span className="block font-mono text-sm text-gray-900">{speech.duration}</span>
        {speech.disqualified ? (
          <span className="block text-[10px] font-bold tracking-wide text-red-600">OVER TIME</span>
        ) : (
          <span className="block text-xs capitalize text-slate-500">{speech.color}</span>
        )}
      </span>
    </li>
  );
}

function SpeechList({ speeches, label }) {
  return (
    <ol aria-label={label} className="m-0 list-none overflow-hidden rounded-xl border border-gray-200 p-0">
      {speeches.map((speech, index) => (
        <SpeechRow key={speech.speechId || index} speech={speech} />
      ))}
    </ol>
  );
}

/**
 * Design B's Report tab (boards B-R01 to B-R04): the speeches timed tonight,
 * copy and clear, and for a club with Pro its archive, history and "End
 * meeting & share". The same report as today's tab, from useReportView.
 */
export default memo(function ReportTabB({ onGoToTimer }) {
  const r = useReportView();
  const { isPro, known } = useEntitlement();
  const { enabled: proEnabled, known: flagsKnown } = useFlag('pro');
  const [showUpgrade, setShowUpgrade] = useState(false);
  const overtime = r.reports.filter((report) => report.disqualified).length;
  const count = r.reports.length;
  const summary = `${count} ${count === 1 ? 'speech' : 'speeches'}${overtime ? ` · ${overtime} over time` : ''}`;
  // The pitch only where Pro can be bought and the club's archive is not already on.
  const offerPro = !r.archiving && known && !isPro && flagsKnown && proEnabled;

  return (
    <div className="flex min-h-full flex-col gap-3.5 px-4 pb-4 pt-2">
      {r.archiving && (
        <div className="flex items-center gap-2 rounded-xl border border-gray-200 bg-slate-50 px-3 py-2">
          <span className="flex min-w-0 flex-1 items-center gap-2 text-xs text-slate-600" data-testid="club-archive-indicator">
            {r.pending > 0 ? (
              <>
                <CloudOff className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
                <span className="truncate">
                  {r.pending} {r.pending === 1 ? 'speech' : 'speeches'} waiting to upload
                </span>
              </>
            ) : (
              <>
                <Check className="h-4 w-4 flex-shrink-0 text-green-600" aria-hidden="true" />
                <span className="truncate">Saved to {r.archiveName}</span>
              </>
            )}
          </span>
          <button type="button" onClick={r.openHistory} className="flex flex-shrink-0 items-center gap-1 text-xs font-semibold text-blue-600 hover:text-blue-700">
            <History className="h-4 w-4" aria-hidden="true" />
            History
          </button>
        </div>
      )}

      <div className="flex items-baseline gap-2">
        <h2 className="m-0 flex-1 text-lg font-bold">Timing report</h2>
        <span className="text-xs text-slate-400">{summary}</span>
      </div>

      {count === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-3 text-center">
          <span className="flex h-[84px] w-[84px] items-center justify-center rounded-3xl bg-blue-50">
            <FileText className="h-10 w-10 text-blue-600" strokeWidth={1.8} aria-hidden="true" />
          </span>
          <strong className="text-[17px]">No speeches timed yet</strong>
          <p className="m-0 text-sm leading-relaxed text-slate-600">
            Each time you press Finish, the speaker, role, time and last colour land here, ready to read out or copy.
          </p>
          {onGoToTimer && (
            <button type="button" onClick={onGoToTimer} className="mt-2 h-11 rounded-xl border border-gray-300 px-4 text-sm font-semibold hover:bg-slate-50">
              Go to the timer
            </button>
          )}
        </div>
      ) : (
        <>
          {r.kit?.showOnReports && <BrandedReportHeader clubName={r.kit.name} primaryColor={r.kit.primaryColor} logoUrl={r.kit.logoUrl} />}
          <SpeechList speeches={r.reports} label="Speeches timed" />
          {overtime > 0 && <p className="m-0 text-xs text-slate-500">Over time: still talking past red plus the role&apos;s grace time.</p>}

          {r.archiving && (
            <button
              type="button"
              onClick={() => r.setShare({ phase: 'title', title: '', result: null })}
              data-testid="end-meeting-share"
              className="flex h-12 items-center justify-center gap-2 rounded-xl bg-gray-900 font-bold text-white hover:bg-black"
            >
              <Share2 className="h-5 w-5" aria-hidden="true" />
              End meeting &amp; share
            </button>
          )}
          <div className="flex gap-2">
            <button type="button" onClick={r.copyToClipboard} className="flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-blue-600 text-sm font-bold text-white hover:bg-blue-700">
              {r.copied ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
              {r.copied ? 'Copied' : 'Copy report'}
            </button>
            <button type="button" onClick={r.handleClear} className="flex h-11 items-center justify-center gap-2 rounded-xl border border-gray-300 px-4 text-sm font-semibold text-red-600 hover:bg-red-50">
              <Trash2 className="h-4 w-4" aria-hidden="true" />
              Clear
            </button>
          </div>
          {r.archiving && <p className="m-0 text-xs text-slate-500">Clear empties this device&apos;s list only. The club&apos;s history keeps every speech.</p>}
        </>
      )}

      {offerPro && count > 0 && (
        <div className="flex items-center gap-2.5 rounded-xl bg-slate-50 px-3 py-2.5 text-xs leading-relaxed text-slate-600">
          <Sparkles className="h-4 w-4 flex-shrink-0 text-blue-600" aria-hidden="true" />
          <span className="flex-1">With Pro, every speech is saved to your club&apos;s history, and you can share the evening in one tap.</span>
          <button type="button" onClick={() => setShowUpgrade(true)} className="flex-shrink-0 font-semibold text-blue-600 hover:underline">
            See Pro
          </button>
        </div>
      )}

      <ConfirmModal
        isOpen={r.showClearConfirm}
        title="Clear the report"
        message="Clear every speech from this device's report? This cannot be undone."
        confirmText="Clear"
        cancelText="Cancel"
        onConfirm={r.handleConfirmClear}
        onCancel={() => r.setShowClearConfirm(false)}
      />

      <Sheet
        open={Boolean(r.share)}
        onClose={() => r.setShare(null)}
        title={r.share?.phase === 'done' ? 'Meeting saved' : 'End this meeting'}
      >
        <div data-testid="share-modal">
          {r.share?.phase === 'title' && (
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1 text-[13px] font-semibold text-slate-700" htmlFor="meeting-title-b">
                Give this meeting a name <span className="font-normal text-slate-400">(optional)</span>
                <input
                  id="meeting-title-b"
                  type="text"
                  value={r.share.title}
                  maxLength={120}
                  placeholder="Humorous Speech Contest"
                  onChange={(event) => r.setShare((prev) => ({ ...prev, title: event.target.value }))}
                  className="h-10 rounded-lg border border-gray-300 px-2.5 text-sm font-normal text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </label>
              <p className="m-0 text-xs text-slate-500">This closes {r.archiveName}&rsquo;s record of the evening. Nothing on this device is cleared.</p>
              <button type="button" onClick={r.endMeeting} data-testid="confirm-end-meeting" className="h-11 rounded-xl bg-blue-600 text-sm font-bold text-white hover:bg-blue-700">
                End meeting &amp; share
              </button>
            </div>
          )}
          {r.share?.phase === 'working' && <p className="py-8 text-center text-sm text-slate-500">Saving the meeting…</p>}
          {r.share?.phase === 'done' && (
            <ShareStep
              clubName={r.archiveName}
              date={r.share.result?.date}
              title={r.share.result?.title}
              speeches={r.share.result?.speeches ?? 0}
              overtime={r.share.result?.overtime ?? 0}
              url={r.share.result?.url ?? null}
              primaryColor={r.kit?.primaryColor}
              imageReady={Boolean(r.share.result?.blob)}
              error={r.share.result?.url ? null : 'The link could not be created just now — the image below still works, and nothing is lost.'}
              onShare={r.onShareChannel}
            />
          )}
        </div>
      </Sheet>

      <Sheet
        open={Boolean(r.history)}
        onClose={() => {
          r.setHistory(null);
          r.setOpenMeeting(null);
        }}
        title={`${r.archiveName} history`}
      >
        <div data-testid="report-history-modal">
          {r.openMeeting ? (
            <>
              <button type="button" onClick={() => r.setOpenMeeting(null)} className="mb-3 flex items-center gap-1 text-sm font-semibold text-blue-600 hover:text-blue-700">
                <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                All meetings
              </button>
              {r.openMeeting.loading ? (
                <p className="py-8 text-center text-sm text-slate-500">Loading the meeting…</p>
              ) : r.openMeeting.error ? (
                <p className="py-8 text-center text-sm text-slate-500">{r.openMeeting.error}</p>
              ) : (
                <div className="flex flex-col gap-3">
                  {r.kit && (
                    <BrandedReportHeader clubName={r.kit.name} primaryColor={r.kit.primaryColor} logoUrl={r.kit.logoUrl} date={r.openMeeting.meeting?.date} />
                  )}
                  <SpeechList speeches={r.openMeeting.meeting?.speeches ?? []} label="Speeches in this meeting" />
                </div>
              )}
            </>
          ) : (
            r.history && (
              <ReportHistoryList
                meetings={r.history.meetings}
                loading={r.history.loading}
                error={r.history.error}
                onSelect={r.selectMeeting}
                primaryColor={r.kit?.primaryColor}
              />
            )
          )}
        </div>
      </Sheet>

      <Sheet
        open={r.showClipboardFallback}
        onClose={() => {
          r.setShowClipboardFallback(false);
          r.setClipboardText('');
        }}
        title="Copy the report"
        description="This Zoom client would not let the app copy. Select the text and copy it yourself."
      >
        <textarea
          value={r.clipboardText}
          readOnly
          aria-label="Report text"
          onClick={(event) => event.target.select()}
          className="h-48 w-full rounded-xl border border-gray-300 p-2.5 font-mono text-xs"
        />
      </Sheet>

      {showUpgrade && (
        <Suspense fallback={null}>
          <UpgradeModal isOpen={showUpgrade} onClose={() => setShowUpgrade(false)} source="report" />
        </Suspense>
      )}
    </div>
  );
});
