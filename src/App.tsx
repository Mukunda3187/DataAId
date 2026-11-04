import React, { useState } from 'react';
import { Sidebar, ActivePage } from './components/Sidebar';
import { Header } from './components/Header';
import { OverviewPage } from './pages/OverviewPage';
import { CorrectionCenterPage } from './pages/CorrectionCenterPage';
import { ReportPage } from './pages/ReportPage';
import { DatamatePage } from './pages/DatamatePage';
import { 
  AnalysisResult, 
  AnalysisSettings,
  ChatMessage
} from './types/dataQuality';

export default function App() {
  const [activePage, setActivePage] = useState<ActivePage>('overview');
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [currentAnalysis, setCurrentAnalysis] = useState<AnalysisResult | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Per-job cache of AI-generated dataset reports so revisiting the Report page
  // does not re-run the AI. Reset on a new dataset upload.
  const [reportCache, setReportCache] = useState<Record<string, { understanding: any; provider: string }>>({});
  // Per-job Datamate conversation history (App-state persistence across page
  // switches). Reset on a new dataset upload; also mirrored server-side.
  const [chatHistoryByJob, setChatHistoryByJob] = useState<Record<string, ChatMessage[]>>({});

  // Upload Dataset (directly on Home Page)
  const handleUploadDataset = async (params: {
    fileName: string;
    fileContent: string;
    fileType: 'csv' | 'xlsx';
    settings: AnalysisSettings;
    datasetName?: string;
  }) => {
    setIsUploading(true);
    setUploadError(null);
    try {
      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params)
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: 'Server error' }));
        throw new Error(errData.error || `Server returned ${res.status}`);
      }

      const analysis: AnalysisResult = await res.json();

      // Ensure required fields exist before switching page
      if (!analysis || !analysis.jobId) {
        throw new Error('Invalid response from server — missing jobId');
      }

      setCurrentAnalysis(analysis);
      // A new dataset starts a fresh conversation and forces a fresh report, so
      // drop any cached report / chat history from a previous dataset.
      setReportCache({});
      setChatHistoryByJob({});
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      setUploadError(msg);
      console.error('Upload failed:', msg);
    } finally {
      setIsUploading(false);
    }
  };

  // Update Correction Items (Approve, Reject, Edit Value)
  const handleUpdateCorrection = async (params: {
    correctionId?: string;
    status?: 'pending' | 'approved' | 'rejected';
    editedValue?: any;
    bulkAction?: 'approve_all' | 'reject_all' | 'approve_safe' | 'approve_column' | 'reject_column' | 'reexamine_dates' | 'restore_snapshot';
    columnName?: string;
    correctedRows?: { rowRef: number; value: string }[];
    snapshot?: any;
    dateFormat?: string;
    dateSeparator?: string;
  }) => {
    if (!currentAnalysis) return;

    try {
      const res = await fetch('/api/corrections/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobId: currentAnalysis.jobId,
          ...params
        })
      });

      if (res.ok) {
        const data = await res.json();
        // Restore and date re-examination return a complete analysis object.
        // For ordinary correction updates, also refresh rows/columns so approved
        // cell replacements are visible immediately in the table.
        if ((params.bulkAction === 'reexamine_dates' || params.bulkAction === 'restore_snapshot') && data.jobId) {
          setCurrentAnalysis(data);
        } else {
          setCurrentAnalysis({
            ...currentAnalysis,
            rawRows: data.rawRows || currentAnalysis.rawRows,
            cleanedRows: data.cleanedRows || currentAnalysis.cleanedRows,
            columns: data.columns || currentAnalysis.columns,
            corrections: data.corrections || currentAnalysis.corrections,
            issues: data.issues || currentAnalysis.issues,
            scoreBefore: data.scoreBefore || currentAnalysis.scoreBefore,
            scoreAfter: data.scoreAfter || currentAnalysis.scoreAfter,
            summary: data.summary || currentAnalysis.summary
          });
        }
      }
    } catch (err) {
      console.error('Failed to update corrections:', err);
    }
  };

  // Directly delete row from active dataset (e.g. duplicate row)
  const handleDeleteRow = async (rowRef: number) => {
    if (!currentAnalysis) return;
    try {
      const res = await fetch('/api/rows/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobId: currentAnalysis.jobId,
          rowRef
        })
      });
      if (res.ok) {
        const updated: AnalysisResult = await res.json();
        setCurrentAnalysis(updated);
      }
    } catch (err) {
      console.error('Failed to delete row:', err);
    }
  };

  // Apply Approved Corrections and Create Updated Dataset
  const handleApplyApproved = async (approveAll?: boolean) => {
    if (!currentAnalysis) return;
    setIsApplying(true);
    try {
      const res = await fetch('/api/corrections/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: currentAnalysis.jobId, approveAll: !!approveAll })
      });

      if (res.ok) {
        const updated: AnalysisResult = await res.json();
        setCurrentAnalysis(updated);
        setActivePage('overview');
      }
    } finally {
      setIsApplying(false);
    }
  };

  // Rescan: re-run full quality detection on the current dataset
  const handleRescan = async () => {
    if (!currentAnalysis) return;
    setIsApplying(true);
    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobId: currentAnalysis.jobId,
          settings: currentAnalysis.settings
        })
      });
      if (res.ok) {
        const updated: AnalysisResult = await res.json();
        setCurrentAnalysis(updated);
      }
    } finally {
      setIsApplying(false);
    }
  };

  // When user re-examines a date column with a custom format,
  // apply corrections via the server so they persist and show in Correction Center
  const handleReexamineDates = async (colName: string, correctedRows: { rowRef: number; value: string }[], dateFormat: string, dateSeparator: string) => {
    if (!currentAnalysis) return;
    await handleUpdateCorrection({
      bulkAction: 'reexamine_dates',
      columnName: colName,
      correctedRows,
      dateFormat,
      dateSeparator
    });
  };

  // Load server-persisted Datamate chat history for a job (fire-and-forget on mount).
  const loadChatHistory = async (jobId: string) => {
    try {
      const res = await fetch('/api/ai/chat-history/' + encodeURIComponent(jobId));
      if (res.ok) {
        const data = await res.json();
        setChatHistoryByJob(prev => ({ ...prev, [jobId]: data.chatHistory || [] }));
      }
    } catch (err) {
      console.error('Failed to load chat history:', err);
    }
  };

  // Unified Datamate send. The user message is appended optimistically for
  // responsiveness, then the server's authoritative chatHistory replaces the
  // local copy (which includes the new assistant message — a text answer or a
  // built-subset card) so nothing is duplicated. The server auto-detects intent
  // from the message, so there is one input and one handler for both questions
  // and subset builds. chatHistoryByJob stays keyed by jobId and resets on a new
  // upload (setChatHistoryByJob({}) in handleUploadDataset).
  const handleDatamateSend = async (message: string, mode: 'ask' | 'build' = 'ask') => {
    if (!currentAnalysis?.jobId) return;
    const jobId = currentAnalysis.jobId;
    const userMsg: ChatMessage = { role: 'user', content: message };
    setChatHistoryByJob(prev => ({ ...prev, [jobId]: [...(prev[jobId] || []), userMsg] }));
    try {
      const res = await fetch('/api/ai/datamate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, message, mode })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not process that message.');
      if (Array.isArray(data.chatHistory)) {
        setChatHistoryByJob(prev => ({ ...prev, [jobId]: data.chatHistory }));
      }
    } catch (err) {
      // Surface the failure in the conversation so the user sees it didn't work.
      const note: ChatMessage = { role: 'assistant', content: 'Sorry, I could not process that. Please try again.' };
      setChatHistoryByJob(prev => ({ ...prev, [jobId]: [...(prev[jobId] || []), note] }));
      throw err;
    }
  };

  const unresolvedCount = currentAnalysis
    ? currentAnalysis.issues.filter(i => i.resolutionStatus === 'pending').length
    : 0;

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col font-sans text-slate-800">
      {/* Sidebar Navigation - only shown after dataset is uploaded */}
      {currentAnalysis && (
        <Sidebar
          activePage={activePage}
          onSelectPage={setActivePage}
          isOpen={isSidebarOpen}
          onClose={() => setIsSidebarOpen(false)}
          unresolvedCount={unresolvedCount}
        />
      )}

      {/* Main Content Area */}
      <div className={`${currentAnalysis ? 'lg:pl-72' : ''} flex-1 flex flex-col min-w-0 transition-all`}>
        <Header
          onOpenSidebar={() => setIsSidebarOpen(true)}
          onNavigateHome={() => setActivePage('overview')}
          onUploadClick={() => {
            setCurrentAnalysis(null);
            setActivePage('overview');
          }}
          hasDataset={!!currentAnalysis}
        />

        <main className="flex-1 p-4 sm:p-8 max-w-7xl w-full mx-auto">
          {activePage === 'overview' && (
            <OverviewPage
              currentAnalysis={currentAnalysis}
              onNavigate={setActivePage}
              onUploadDataset={handleUploadDataset}
              isUploading={isUploading}
              uploadError={uploadError}
            />
          )}

          {activePage === 'corrections' && currentAnalysis && (
            <CorrectionCenterPage
              corrections={currentAnalysis.corrections}
              issues={currentAnalysis.issues}
              rawRows={currentAnalysis.rawRows}
              columns={currentAnalysis.columns}
              onUpdateCorrection={handleUpdateCorrection}
              onDeleteRow={handleDeleteRow}
              onApplyApproved={handleApplyApproved}
              onRescan={handleRescan}
              isApplying={isApplying}
            />
          )}

          {activePage === 'report' && (
            <ReportPage
              currentAnalysis={currentAnalysis}
              onNavigate={setActivePage}
              report={currentAnalysis ? reportCache[currentAnalysis.jobId] : undefined}
              onReportLoaded={(payload) => currentAnalysis && setReportCache(prev => ({ ...prev, [currentAnalysis.jobId]: payload }))}
            />
          )}

          {activePage === 'datamate' && (
            <DatamatePage
              currentAnalysis={currentAnalysis}
              onNavigate={setActivePage}
              messages={currentAnalysis ? (chatHistoryByJob[currentAnalysis.jobId] || []) : []}
              onSend={handleDatamateSend}
              onRequestHistory={loadChatHistory}
            />
          )}
        </main>
      </div>
    </div>
  );
}
