import React, { useEffect, useState } from 'react';
import { 
  FileText,
  Download,
  Filter,
  BrainCircuit,
  Sparkles
} from 'lucide-react';
import { AnalysisResult, CorrectionItem } from '../types/dataQuality';
import { ActivePage } from '../components/Sidebar';

interface ReportPageProps {
  currentAnalysis: AnalysisResult | null;
  onNavigate: (page: ActivePage) => void;
  // Cached AI understanding keyed by job in App state; when provided the page
  // does not re-fetch (and does not re-run the AI) on revisit.
  report?: { understanding: any; provider: string };
  // Lets the page hand a freshly fetched report back to App for caching.
  onReportLoaded?: (payload: { understanding: any; provider: string }) => void;
}

export const ReportPage: React.FC<ReportPageProps> = ({
  currentAnalysis,
  onNavigate,
  report,
  onReportLoaded
}) => {
  const [activeTab, setActiveTab] = useState<'understanding' | 'table'>('understanding');
  const [understanding, setUnderstanding] = useState<any>(null);
  const [understandingProvider, setUnderstandingProvider] = useState('');
  const [understandingLoading, setUnderstandingLoading] = useState(false);
  const [understandingError, setUnderstandingError] = useState('');
  const [filterStatus, setFilterStatus] = useState<'all' | 'applied_or_approved' | 'pending'>('all');

  useEffect(() => {
    const jobId = currentAnalysis?.jobId;
    if (!jobId) return;

    // If a cached report is already available in App state, seed local state from
    // it and skip the network call so revisiting the page does not re-run the AI.
    if (report) {
      setUnderstanding(report.understanding);
      setUnderstandingProvider(report.provider || '');
      setUnderstandingLoading(false);
      return;
    }

    let cancelled = false;
    const loadUnderstanding = async () => {
      setUnderstandingLoading(true);
      setUnderstandingError('');
      try {
        const response = await fetch('/api/ai/understand-dataset', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobId })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not understand this dataset.');
        if (!cancelled) {
          setUnderstanding(data.understanding);
          setUnderstandingProvider(data.provider || '');
          // Hand the report back to App so the next visit is served from cache.
          onReportLoaded?.({ understanding: data.understanding, provider: data.provider || '' });
        }
      } catch (error) {
        if (!cancelled) setUnderstandingError(error instanceof Error ? error.message : 'Could not understand this dataset.');
      } finally {
        if (!cancelled) setUnderstandingLoading(false);
      }
    };
    loadUnderstanding();
    return () => { cancelled = true; };
    // Re-run only when the job changes. `report` is intentionally excluded: the
    // cache is keyed by job, so we do not refetch when the cache object updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentAnalysis?.jobId]);

  if (!currentAnalysis) {
    return (
      <div className="bg-white rounded-2xl border border-slate-200 p-12 text-center max-w-md mx-auto shadow-xs my-10">
        <FileText className="w-12 h-12 text-slate-300 mx-auto mb-3" />
        <h3 className="text-base font-bold text-slate-900">No Dataset Loaded</h3>
        <p className="text-xs text-slate-500 mt-1 mb-5">
          Upload a dataset to see its AI-generated explanation and column descriptions.
        </p>
        <button
          onClick={() => onNavigate('overview')}
          className="px-4 py-2 rounded-lg bg-[#086288] text-white text-xs font-bold hover:bg-[#053b53] transition cursor-pointer"
        >
          Go to Home
        </button>
      </div>
    );
  }

  const { corrections = [], issues = [] } = currentAnalysis;

  // Helper to extract a concise one-line reason
  const getOneLineReason = (item: CorrectionItem): string => {
    const issue = issues.find(i => i.id === item.issueId);
    const orig = String(item.originalValue ?? '');
    const proposed = String(item.editedValue ?? item.proposedValue ?? '');

    if (item.proposedValue === 'DROP_ROW' || issue?.category === 'duplicate_record') {
      return 'Removes duplicate row to ensure record uniqueness.';
    }
    if (issue?.category === 'missing_value' || orig.trim() === '') {
      return `Fills empty cell with contextual AI word "${proposed || 'Standard'}".`;
    }
    if (issue?.category === 'inconsistent_category') {
      return `Normalizes variant "${orig}" to canonical category "${proposed}".`;
    }
    if (issue?.category === 'invalid_format') {
      if (/date/i.test(item.column)) {
        return 'Converts non-standard date to ISO format (YYYY-MM-DD).';
      }
      return `Normalizes value to standard format "${proposed}".`;
    }
    if (issue?.category === 'business_rule_violation') {
      return `Adjusts out-of-range value to policy threshold "${proposed}".`;
    }
    if (issue?.category === 'potential_outlier') {
      return `Replaces statistical outlier with median value "${proposed}".`;
    }
    if (item.reason) {
      return item.reason.split('.')[0] + '.';
    }
    return 'Corrects anomaly to ensure schema compliance.';
  };

  const filteredCorrections = corrections.filter(c => {
    if (filterStatus === 'applied_or_approved') {
      return c.status === 'applied' || c.status === 'approved';
    }
    if (filterStatus === 'pending') {
      return c.status === 'pending';
    }
    return true;
  });

  const appliedCount = corrections.filter(c => c.status === 'applied' || c.status === 'approved').length;

  const handleExportReportCSV = () => {
    const headers = ['Row Ref', 'Column', 'Previous Value', 'Changed Value', 'Status', 'Reason'];
    const rows = filteredCorrections.map(item => {
      const orig = item.originalValue === '' ? '<blank>' : String(item.originalValue ?? '');
      const changed = item.proposedValue === 'DROP_ROW' ? 'DROP_ROW (Deleted)' : String(item.editedValue ?? item.proposedValue ?? '');
      const reason = getOneLineReason(item);
      return [
        item.rowRef,
        item.column,
        `"${orig.replace(/"/g, '""')}"`,
        `"${changed.replace(/"/g, '""')}"`,
        item.status,
        `"${reason.replace(/"/g, '""')}"`
      ].join(',');
    });

    const csvContent = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `DataAId_Change_Report_${currentAnalysis.summary.name.replace(/[^a-zA-Z0-9_-]/g, '_')}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      {/* Header Bar */}
      <div className="bg-white rounded-xl border border-slate-200 p-5 sm:p-6 shadow-xs flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#97D7FF]/20 text-[#086288] text-xs font-semibold">
              <BrainCircuit className="w-3.5 h-3.5 text-[#086288]" />
              <span>Dataset Understanding</span>
            </span>
            <span className="text-xs text-slate-300">•</span>
            <span className="text-xs text-slate-600 font-medium">
              {currentAnalysis.summary.columnCount} Columns Analyzed
            </span>
          </div>

          <h2 className="text-xl font-bold text-slate-900 tracking-tight">
            {currentAnalysis.summary.name}
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            AI explanation of your dataset and its columns
          </p>
        </div>

        {/* View Switcher Tabs & Download */}
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex rounded-lg border border-slate-200 p-0.5 bg-slate-50 text-xs font-semibold">
            <button
              onClick={() => setActiveTab('understanding')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md transition cursor-pointer ${
                activeTab === 'understanding'
                  ? 'bg-[#086288] text-white shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <BrainCircuit className="w-3.5 h-3.5" />
              <span>Dataset Understanding</span>
            </button>
            <button
              onClick={() => setActiveTab('table')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md transition cursor-pointer ${
                activeTab === 'table'
                  ? 'bg-[#086288] text-white shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <FileText className="w-3.5 h-3.5" />
              <span>Transformation Table ({corrections.length})</span>
            </button>
          </div>

          <button
            onClick={handleExportReportCSV}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-[#086288] hover:bg-[#053b53] text-white text-xs font-bold transition shadow-xs cursor-pointer"
            title="Download Change Report CSV"
          >
            <Download className="w-3.5 h-3.5 text-[#97D7FF]" />
            <span>Export CSV</span>
          </button>
        </div>
      </div>

      {/* Summary KPI Banner */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <div className="p-4 bg-white rounded-xl border border-slate-200 shadow-xs">
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">Initial Errors Found</span>
          <div className="text-2xl font-extrabold text-amber-600 mt-1">{issues.length}</div>
          <span className="text-[11px] text-slate-500">Detected on initial upload</span>
        </div>

        <div className="p-4 bg-white rounded-xl border border-slate-200 shadow-xs">
          <span className="text-xs font-semibold uppercase tracking-wider text-[#086288]">Applied Transformations</span>
          <div className="text-2xl font-extrabold text-[#086288] mt-1">{appliedCount}</div>
          <span className="text-[11px] text-slate-500">Approved & implemented changes</span>
        </div>

        <div className="p-4 bg-white rounded-xl border border-slate-200 shadow-xs">
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">Quality Health Score</span>
          <div className="flex items-baseline gap-2 mt-1">
            <span className="text-2xl font-extrabold text-[#086288]">
              {currentAnalysis.scoreAfter ? currentAnalysis.scoreAfter.overall : currentAnalysis.scoreBefore.overall}%
            </span>
            {currentAnalysis.scoreAfter && (
              <span className="text-xs font-bold text-emerald-600">
                +{currentAnalysis.scoreAfter.overall - currentAnalysis.scoreBefore.overall}% from baseline
              </span>
            )}
          </div>
          <span className="text-[11px] text-slate-500">Overall dataset health</span>
        </div>

        <div className="p-4 bg-white rounded-xl border border-slate-200 shadow-xs">
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">Dataset Size</span>
          <div className="text-2xl font-extrabold text-slate-800 mt-1">{currentAnalysis.summary.rowCount.toLocaleString()} Rows</div>
          <span className="text-[11px] text-slate-500">Across {currentAnalysis.summary.columnCount} columns</span>
        </div>
      </div>

      {/* VIEW 1: AI DATASET UNDERSTANDING */}
      {activeTab === 'understanding' && (
        <div className="space-y-5">
          {understandingLoading && (
            <div className="bg-white rounded-xl border border-slate-200 p-10 text-center">
              <Sparkles className="w-8 h-8 text-[#086288] mx-auto mb-3 animate-pulse" />
              <h3 className="font-bold text-slate-900">Understanding your dataset...</h3>
              <p className="text-sm text-slate-500 mt-1">AI is reviewing column names, data types and sample values.</p>
            </div>
          )}
          {understandingError && (
            <div className="bg-rose-50 border border-rose-200 rounded-xl p-4 text-sm text-rose-700">{understandingError}</div>
          )}
          {understanding && !understandingLoading && (
            <>
              <section className="bg-white rounded-xl border border-slate-200 p-5 sm:p-6 shadow-xs">
                <div className="flex items-center gap-2 mb-3">
                  <BrainCircuit className="w-5 h-5 text-[#086288]" />
                  <h3 className="font-bold text-slate-900">What does this dataset contain?</h3>
                  <span className="ml-auto text-[10px] px-2 py-1 rounded-full bg-[#97D7FF]/30 text-[#086288] font-bold">{understandingProvider}</span>
                </div>
                <p className="text-sm leading-6 text-slate-700">{understanding.datasetOverview}</p>
                <div className="mt-4 rounded-lg bg-slate-50 border border-slate-200 p-4">
                  <h4 className="text-xs font-bold uppercase tracking-wide text-slate-500 mb-1">Possible purpose</h4>
                  <p className="text-sm text-slate-700 leading-6">{understanding.likelyPurpose}</p>
                </div>
              </section>

              <section className="bg-white rounded-xl border border-slate-200 shadow-xs overflow-hidden">
                <div className="p-5 border-b border-slate-200">
                  <h3 className="font-bold text-slate-900">Understand each column</h3>
                  <p className="text-xs text-slate-500 mt-1">Simple explanations based on column names and the dataset profile.</p>
                </div>
                <div className="divide-y divide-slate-100">
                  {understanding.columnDescriptions.map((column: any, index: number) => {
                    const profile = currentAnalysis.columns.find(item => item.name === column.name);
                    return (
                      <div key={`${column.name}-${index}`} className="p-4 sm:p-5 grid grid-cols-1 lg:grid-cols-[190px_1fr] gap-3">
                        <div>
                          <div className="font-semibold text-sm text-slate-900 break-words">{column.name}</div>
                          <span className="inline-block mt-1 text-[10px] font-bold uppercase rounded bg-slate-100 text-slate-600 px-2 py-1">{column.dataType}</span>
                        </div>
                        <div className="space-y-2">
                          <p className="text-sm text-slate-700 leading-6">{column.meaning}</p>
                          <p className="text-xs text-slate-500 leading-5">{column.observations}</p>
                          {profile && <div className="flex flex-wrap gap-3 text-[11px] text-slate-500"><span>{profile.missingCount} missing</span><span>{profile.uniqueCount} unique values</span><span>{profile.issuesCount} detected issues</span></div>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>

              {Array.isArray(understanding.keyInsights) && understanding.keyInsights.length > 0 && (
                <section className="bg-white rounded-xl border border-slate-200 p-5 shadow-xs">
                  <h3 className="font-bold text-slate-900 mb-3">Key insights</h3>
                  <ul className="space-y-2">
                    {understanding.keyInsights.map((insight: string, index: number) => <li key={index} className="flex gap-2 text-sm text-slate-700"><span className="text-[#086288] font-bold">•</span><span>{insight}</span></li>)}
                  </ul>
                </section>
              )}
            </>
          )}
          {!understandingLoading && !understanding && !understandingError && (
            <div className="bg-white rounded-xl border border-slate-200 p-8 text-center text-sm text-slate-500">Dataset understanding is not available yet.</div>
          )}
        </div>
      )}

      {/* VIEW 2: TRANSFORMATION AUDIT TABLE */}
      {activeTab === 'table' && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-xs overflow-hidden">
          <div className="p-4 sm:p-5 border-b border-slate-200 bg-slate-50 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                <FileText className="w-4 h-4 text-[#086288]" />
                <span>Transformation Audit Table</span>
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Exact log of all modifications, column replacements, and row removals.
              </p>
            </div>

            <div className="flex items-center gap-2">
              <Filter className="w-3.5 h-3.5 text-slate-400" />
              <select
                value={filterStatus}
                onChange={e => setFilterStatus(e.target.value as any)}
                className="text-xs bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 font-medium text-slate-700 focus:outline-none focus:border-[#086288]"
              >
                <option value="all">All Transformations ({corrections.length})</option>
                <option value="applied_or_approved">Applied & Approved ({appliedCount})</option>
                <option value="pending">Pending ({corrections.length - appliedCount})</option>
              </select>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left">
              <thead className="bg-slate-50 text-slate-700 font-bold border-b border-slate-200 uppercase tracking-wider text-[11px]">
                <tr>
                  <th className="py-3 px-4">Row #</th>
                  <th className="py-3 px-4">Column</th>
                  <th className="py-3 px-4">Original Value</th>
                  <th className="py-3 px-4">Changed Value</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4">Reason</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredCorrections.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-12 text-center text-slate-400">
                      No transformations match the selected filter.
                    </td>
                  </tr>
                ) : (
                  filteredCorrections.map(item => {
                    const isDrop = item.proposedValue === 'DROP_ROW';
                    const orig = item.originalValue === '' ? '<blank>' : String(item.originalValue ?? '');
                    const changed = isDrop ? 'DELETED / DEDUPLICATED' : String(item.editedValue ?? item.proposedValue ?? '');
                    const reason = getOneLineReason(item);

                    return (
                      <tr key={item.id} className="hover:bg-slate-50/80 transition">
                        <td className="py-3 px-4 font-mono font-bold text-slate-900">
                          #{item.rowRef}
                        </td>
                        <td className="py-3 px-4 font-semibold text-slate-800">
                          {item.column}
                        </td>
                        <td className="py-3 px-4">
                          <span className="font-mono px-2 py-0.5 rounded bg-slate-100 text-slate-600 line-through">
                            {orig}
                          </span>
                        </td>
                        <td className="py-3 px-4">
                          {isDrop ? (
                            <span className="font-bold text-rose-700 bg-rose-50 px-2 py-0.5 rounded border border-rose-200">
                              {changed}
                            </span>
                          ) : (
                            <span className="font-mono font-bold text-[#086288] bg-[#97D7FF]/20 px-2 py-0.5 rounded border border-[#4D8DBA]/30">
                              {changed}
                            </span>
                          )}
                        </td>
                        <td className="py-3 px-4">
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${
                            item.status === 'applied' || item.status === 'approved'
                              ? 'bg-emerald-100 text-emerald-800'
                              : item.status === 'rejected'
                              ? 'bg-rose-100 text-rose-800'
                              : 'bg-amber-100 text-amber-800'
                          }`}>
                            {item.status}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-slate-600 max-w-sm">
                          {reason}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
