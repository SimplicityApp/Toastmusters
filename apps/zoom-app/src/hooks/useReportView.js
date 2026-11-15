import { useState } from 'react';
import { useTimer } from '../context/TimerContext';
import { useToast } from '../context/ToastContext';
import { clubFeaturesOn, fetchHistory, fetchMeeting, endMeetingAndShare, copyReportImage } from '@toastmaster-timer/shared';
import { useClub, useOutboxPending } from './useClub';
import { getSessionToken } from '../utils/zoomIdentity';
import { trackEvent } from '../utils/posthog';

export const UNREACHABLE = 'Could not reach the club just now. Nothing is lost — this device keeps its own copy.';

/**
 * Everything the Report tab does, apart from how it looks: the speeches timed
 * on this device, copying them, clearing them, and for a club with Pro the
 * archive strip, its history, and ending the meeting with a link and a
 * picture to share.
 *
 * Lifted out of ReportTab unchanged so design B's Report tab (plan 13) shows
 * the same report without a second copy of the logic.
 *
 * @returns {Object} state and handlers for a report view
 */
export function useReportView() {
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
  // null | { phase: 'title'|'working'|'done', title, result }
  const [share, setShare] = useState(null);

  // A lapsed club keeps its cached record (the device still knows which club to
  // re-check) but stops archiving, so the strip and History go with it. So
  // does a club while Pro is not released (clubFeaturesOn).
  const archiving = clubFeaturesOn(club);
  const archiveName = clubName || club?.club?.name || 'your club';

  const endMeeting = async () => {
    const title = share?.title ?? '';
    setShare({ phase: 'working', title, result: null });
    const result = await endMeetingAndShare({ title, speeches: reports, getToken: getSessionToken });
    setShare({ phase: 'done', title, result });
    trackEvent('meeting_ended', {
      speeches: result.speeches,
      overtime: result.overtime,
      titled: Boolean(result.title),
      shared: Boolean(result.url),
      surface: 'zoom',
    });
  };

  // Every destination reports itself, so the "artifacts that travel" thesis has
  // a number behind it rather than an intuition.
  const onShareChannel = async (channel) => {
    const result = share?.result;
    trackEvent('report_shared', { channel, surface: 'zoom' });
    if (channel === 'image') {
      const copied = await copyReportImage(result?.blob, { filename: result?.filename });
      if (!copied.ok) {
        showToast('That image could not be copied on this device', 'warning');
        return false;
      }
      if (copied.method === 'download') showToast('Image downloaded', 'success');
      return true;
    }
    if (channel === 'link') {
      try {
        await navigator.clipboard.writeText(result.url);
        return true;
      } catch {
        showToast('Could not copy the link', 'warning');
        return false;
      }
    }
    return true;
  };

  const openHistory = async () => {
    setOpenMeeting(null);
    setHistory({ loading: true, error: null, meetings: [] });
    const result = await fetchHistory({ getToken: getSessionToken });
    if (!result.ok) {
      setHistory({ loading: false, error: UNREACHABLE, meetings: [] });
      return;
    }
    setHistory({ loading: false, error: null, meetings: result.meetings });
    trackEvent('report_history_viewed', { meetings: result.meetings.length, surface: 'zoom' });
  };

  const selectMeeting = async (meetingId) => {
    setOpenMeeting({ loading: true, error: null, meeting: null });
    const result = await fetchMeeting(meetingId, { getToken: getSessionToken });
    if (!result.ok) {
      setOpenMeeting({ loading: false, error: UNREACHABLE, meeting: null });
      return;
    }
    setOpenMeeting({ loading: false, error: null, meeting: result.meeting });
  };


  const copyToClipboard = async () => {
    if (reports.length === 0) {
      showToast('No reports to copy', 'warning');
      return;
    }

    // Format as tab-separated values
    const header = 'Name\tRole\tDuration\tStatus\tOver time\tComments\n';
    const rows = reports.map(r =>
      `${r.name}\t${r.role}\t${r.duration}\t${r.color}\t${r.disqualified ? 'Yes' : ''}\t${r.comments || ''}`
    ).join('\n');
    const text = header + rows;

    // The secondary destination, and the oldest one. Counted alongside the
    // others so "reports that travel" is one funnel rather than two.
    trackEvent('report_shared', { channel: 'text', surface: 'zoom' });

    try {
      // Check if clipboard API is available
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
        showToast('Copied to clipboard', 'success');
      } else {
        // Fallback: show modal with text
        setClipboardText(text);
        setShowClipboardFallback(true);
      }
    } catch (error) {
      console.error('Failed to copy:', error);
      // Fallback: show modal with text
      setClipboardText(text);
      setShowClipboardFallback(true);
    }
  };

  const handleClear = () => {
    if (reports.length === 0) {
      return;
    }
    setShowClearConfirm(true);
  };

  // Deliberately local only: the archive is the club's record of the evening
  // and clearing this device's scratch list must not reach into it.
  const handleConfirmClear = () => {
    clearAllReports();
    setShowClearConfirm(false);
  };

  return {
    reports,
    club,
    kit,
    clubName,
    pending,
    copied,
    showClearConfirm,
    setShowClearConfirm,
    showClipboardFallback,
    setShowClipboardFallback,
    clipboardText,
    setClipboardText,
    history,
    setHistory,
    openMeeting,
    setOpenMeeting,
    share,
    setShare,
    archiving,
    archiveName,
    endMeeting,
    onShareChannel,
    openHistory,
    selectMeeting,
    copyToClipboard,
    handleClear,
    handleConfirmClear,
  };
}
