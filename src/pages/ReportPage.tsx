import React, { useState } from 'react';
import { 
  FileText, 
  CheckCircle2, 
  Clock, 
  Download, 
  Filter,
  Layers,
  ChevronDown,
  AlertTriangle,
  History,
  ShieldCheck,
  User,
  Wrench,
  Check,
  ArrowRight
} from 'lucide-react';
import { AnalysisResult, CorrectionItem, CommitLogEntry } from '../types/dataQuality';
import { ActivePage } from '../components/Sidebar';

interface ReportPageProps {
  currentAnalysis: AnalysisResult | null;
  onNavigate: (page: ActivePage) => void;
}

export const ReportPage: React.FC<ReportPageProps> = ({
  currentAnalysis,
  onNavigate
}) => {
  const [activeTab, setActiveTab] = useState<'tracking' | 'table'>('tracking');
  const [filterStatus, setFilterStatus] = useState<'all' | 'applied_or_approved' | 'pending'>('all');
  const [expandedIndex, setExpandedIndex] = useState<number | null>(0);
  const [showAllInitialErrors, setShowAllInitialErrors] = useState(false);
  const [expandedApprovals, setExpandedApprovals] = useState<Set<number>>(new Set());

  if (!currentAnalysis) {
    return (
      <div className="bg-white rounded-2xl border border-slate-200 p-12 text-center max-w-md mx-auto shadow-xs my-10">
        <FileText className="w-12 h-12 text-slate-300 mx-auto mb-3" />
        <h3 className="text-base font-bold text-slate-900">No Dataset Loaded</h3>
        <p className="text-xs text-slate-500 mt-1 mb-5">
          Upload a dataset to inspect history tracking and quality reports.
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

  const { corrections = [], issues = [], historyLog = [] } = currentAnalysis;

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

  // Build clean history tracking array (no unique codes/hashes)
  const trackingEntries = historyLog.map((log, index) => {
    return {
      stepNumber: index + 1,
      timestamp: log.timestamp || new Date().toISOString(),
      action: log.action || 'Dataset Update',
      author: log.author || (index === 0 ? 'DataAId Engine' : 'User (Action)'),
      details: log.details || '',
      type: log.type || (index === 0 ? 'upload' : 'apply'),
      stats: log.stats,
      initialErrorsSummary: log.initialErrorsSummary
    };
  });

  // Stacked timeline: display latest action on top down to initial upload
  const reversedTracking = [...trackingEntries].reverse();

  // Helper formatting for timestamps
  const formatTimestamp = (iso: string) => {
    try {
      const d = new Date(iso);
      return d.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
    } catch {
      return iso;
    }
  };

  return (
    <div className="space-y-6">
      {/* Header Bar */}
      <div className="bg-white rounded-xl border border-slate-200 p-5 sm:p-6 shadow-xs flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#97D7FF]/20 text-[#086288] text-xs font-semibold">
              <History className="w-3.5 h-3.5 text-[#086288]" />
              <span>History Tracking</span>
            </span>
            <span className="text-xs text-slate-300">•</span>
            <span className="text-xs text-slate-600 font-medium">
              {trackingEntries.length} Event{trackingEntries.length !== 1 ? 's' : ''} Logged
            </span>
          </div>

          <h2 className="text-xl font-bold text-slate-900 tracking-tight">
            {currentAnalysis.summary.name}
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            Dataset Activity & Quality Report
          </p>
        </div>

        {/* View Switcher Tabs & Download */}
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex rounded-lg border border-slate-200 p-0.5 bg-slate-50 text-xs font-semibold">
            <button
              onClick={() => setActiveTab('tracking')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md transition cursor-pointer ${
                activeTab === 'tracking'
                  ? 'bg-[#086288] text-white shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <History className="w-3.5 h-3.5" />
              <span>History Tracking ({trackingEntries.length})</span>
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
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">History Steps</span>
          <div className="text-2xl font-extrabold text-slate-800 mt-1">{trackingEntries.length} Recorded</div>
          <span className="text-[11px] text-slate-500">Scoped strictly to active dataset</span>
        </div>
      </div>

      {/* VIEW 1: HISTORY TRACKING TIMELINE */}
      {activeTab === 'tracking' && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-xs overflow-hidden">
          {/* Header Bar */}
          <div className="p-4 sm:p-5 border-b border-slate-200 bg-slate-50/70 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                <History className="w-4 h-4 text-[#086288]" />
                <span>Dataset History Tracking</span>
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Chronological log from dataset upload to applied transformations.
              </p>
            </div>
            <div className="inline-flex items-center gap-2 text-xs text-slate-600 font-medium">
              <span className="inline-block w-2.5 h-2.5 rounded-full bg-emerald-500"></span>
              <span>Active Dataset State</span>
            </div>
          </div>

          {/* Vertical Tracking Line Container */}
          <div className="p-6 relative">
            {/* Vertical timeline line */}
            <div className="absolute left-10 sm:left-12 top-10 bottom-10 w-0.5 bg-slate-200"></div>

            <div className="space-y-8 relative">
              {reversedTracking.map((entry, revIdx) => {
                const originalIndex = trackingEntries.length - 1 - revIdx;
                const isLatest = revIdx === 0;
                const isInitialUpload = originalIndex === 0;
                const isExpanded = expandedIndex === originalIndex;

                return (
                  <div key={`entry-${originalIndex}`} className="flex items-start gap-4 sm:gap-6 group">
                    {/* Node Icon */}
                    <div className="relative z-10 shrink-0">
                      <div className={`w-8 h-8 sm:w-10 sm:h-10 rounded-full flex items-center justify-center border-2 shadow-xs transition ${
                        isInitialUpload
                          ? 'bg-[#086288] border-white text-white ring-4 ring-[#97D7FF]/40'
                          : isLatest
                          ? 'bg-[#4D8DBA] border-white text-white ring-4 ring-[#97D7FF]/30'
                          : entry.type === 'approval'
                          ? 'bg-[#086288] border-white text-white'
                          : entry.type === 'edit'
                          ? 'bg-amber-600 border-white text-white'
                          : 'bg-slate-700 border-white text-white'
                      }`}>
                        {isInitialUpload ? (
                          <Layers className="w-4 h-4 sm:w-5 sm:h-5" />
                        ) : isLatest ? (
                          <CheckCircle2 className="w-4 h-4 sm:w-5 sm:h-5" />
                        ) : entry.type === 'approval' ? (
                          <Check className="w-4 h-4 sm:w-5 sm:h-5" />
                        ) : entry.type === 'edit' ? (
                          <Wrench className="w-4 h-4 sm:w-5 sm:h-5" />
                        ) : (
                          <History className="w-4 h-4 sm:w-5 sm:h-5" />
                        )}
                      </div>
                    </div>

                    {/* Tracking Card */}
                    <div className="flex-1 bg-white rounded-xl border border-slate-200 hover:border-slate-300 transition shadow-xs overflow-hidden">
                      {/* Card Header */}
                      <div 
                        onClick={() => setExpandedIndex(isExpanded ? null : originalIndex)}
                        className="p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 cursor-pointer hover:bg-slate-50/60 transition"
                      >
                        <div className="space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            {isLatest && (
                              <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-emerald-100 text-emerald-800 border border-emerald-200">
                                Latest State
                              </span>
                            )}
                            {isInitialUpload && (
                              <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-[#97D7FF]/30 text-[#086288] border border-[#086288]/20">
                                Initial Upload
                              </span>
                            )}
                            <h4 className="text-sm font-bold text-slate-900 group-hover:text-[#086288] transition-colors">
                              {entry.action}
                            </h4>
                          </div>

                          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                            <span className="inline-flex items-center gap-1 font-medium text-slate-700">
                              <User className="w-3 h-3 text-slate-400" />
                              <span>{entry.author || 'DataAId Engine'}</span>
                            </span>
                            <span>•</span>
                            <span className="inline-flex items-center gap-1">
                              <Clock className="w-3 h-3 text-slate-400" />
                              <span>{formatTimestamp(entry.timestamp)}</span>
                            </span>
                          </div>
                        </div>

                        {/* Step indicator */}
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="text-xs font-semibold text-slate-500 px-2 py-0.5 rounded bg-slate-100">
                            Step {entry.stepNumber}
                          </span>
                        </div>
                      </div>

                      {/* Details & Details Preview */}
                      <div className="px-4 sm:px-5 pb-4 border-t border-slate-100 pt-3 bg-slate-50/30">
                        <p className="text-xs text-slate-700 leading-relaxed">
                          {entry.details}
                        </p>

                        {/* APPROVAL ENTRY: show sub-corrections collapsed, expand with chevron */}
                        {(entry.type === 'approval' || entry.type === 'apply' || entry.type === 'edit') && (() => {
                          // Find corrections related to this log entry by timestamp proximity
                          // Group: show all approved/applied corrections as sub-items
                          const approvedCors = corrections.filter(
                            c => c.status === 'approved' || c.status === 'applied'
                          );
                          if (approvedCors.length === 0) return null;
                          const isSubExpanded = expandedApprovals.has(originalIndex);
                          return (
                            <div className="mt-3">
                              <button
                                type="button"
                                onClick={e => {
                                  e.stopPropagation();
                                  setExpandedApprovals(prev => {
                                    const next = new Set(prev);
                                    if (next.has(originalIndex)) next.delete(originalIndex);
                                    else next.add(originalIndex);
                                    return next;
                                  });
                                }}
                                className="inline-flex items-center gap-1.5 text-xs font-bold text-[#086288] hover:underline cursor-pointer"
                              >
                                <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isSubExpanded ? 'rotate-180' : ''}`} />
                                <span>{isSubExpanded ? 'Hide' : 'Show'} {approvedCors.length} approved correction{approvedCors.length !== 1 ? 's' : ''}</span>
                              </button>

                              {isSubExpanded && (
                                <div className="mt-2 max-h-56 overflow-y-auto rounded-lg border border-slate-200 bg-white divide-y divide-slate-100">
                                  {approvedCors.map((cor, ci) => {
                                    const isDrop = cor.proposedValue === 'DROP_ROW';
                                    const finalVal = cor.editedValue !== undefined ? cor.editedValue : cor.proposedValue;
                                    return (
                                      <div key={cor.id} className="flex items-center justify-between gap-3 px-3 py-2 text-xs hover:bg-slate-50">
                                        <div className="flex items-center gap-2 min-w-0">
                                          <span className="font-mono text-slate-400 shrink-0">#{cor.rowRef}</span>
                                          <span className="font-semibold text-slate-700 truncate">{cor.column}</span>
                                          <ArrowRight className="w-3 h-3 text-slate-300 shrink-0" />
                                          {isDrop ? (
                                            <span className="font-bold text-rose-700">Drop Row</span>
                                          ) : (
                                            <span className="font-bold text-[#086288] truncate">{String(finalVal)}</span>
                                          )}
                                        </div>
                                        <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-bold ${
                                          cor.status === 'applied'
                                            ? 'bg-emerald-100 text-emerald-800'
                                            : 'bg-[#97D7FF]/30 text-[#086288]'
                                        }`}>
                                          {cor.status}
                                        </span>
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          );
                        })()}

                        {/* INITIAL UPLOAD SPECIAL SECTION: WHAT ERRORS ARE THERE AT FIRST */}
                        {isInitialUpload && (
                          <div className="mt-4 p-4 rounded-xl bg-amber-50/70 border border-amber-200/80 space-y-3">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2 text-xs font-bold text-amber-900">
                                <AlertTriangle className="w-4 h-4 text-amber-600" />
                                <span>Initial Errors Detected on Upload ({issues.length} Total Issues)</span>
                              </div>
                              <span className="text-[11px] font-semibold text-amber-700">
                                Baseline Quality Score: {currentAnalysis.scoreBefore.overall}%
                              </span>
                            </div>

                            {/* Error Categories Breakdown */}
                            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                              {entry.initialErrorsSummary && entry.initialErrorsSummary.length > 0 ? (
                                entry.initialErrorsSummary.map((errItem) => (
                                  <div 
                                    key={errItem.category}
                                    className="p-2.5 rounded-lg bg-white border border-amber-200 shadow-2xs flex flex-col justify-between"
                                  >
                                    <div className="flex items-center justify-between gap-1">
                                      <span className="text-xs font-bold text-slate-900">{errItem.title}</span>
                                      <span className="text-xs font-extrabold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">
                                        {errItem.count}
                                      </span>
                                    </div>
                                    <div className="text-[10px] text-slate-500 mt-1 truncate">
                                      Columns: {errItem.columns.slice(0, 2).join(', ')}
                                      {errItem.columns.length > 2 ? ` +${errItem.columns.length - 2}` : ''}
                                    </div>
                                  </div>
                                ))
                              ) : (
                                <div className="col-span-full text-xs text-slate-500 py-1">
                                  {issues.length > 0 ? (
                                    <span>Identified {issues.length} errors across dataset columns.</span>
                                  ) : (
                                    <span className="text-emerald-700 font-bold">No data quality errors detected upon initial scan.</span>
                                  )}
                                </div>
                              )}
                            </div>

                            {/* Expandable itemized initial errors list */}
                            {issues.length > 0 && (
                              <div className="pt-2">
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setShowAllInitialErrors(!showAllInitialErrors);
                                  }}
                                  className="text-xs font-bold text-[#086288] hover:underline flex items-center gap-1 cursor-pointer"
                                >
                                  <span>{showAllInitialErrors ? 'Hide' : 'View'} full initial error inventory ({issues.length} items)</span>
                                  <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showAllInitialErrors ? 'rotate-180' : ''}`} />
                                </button>

                                {showAllInitialErrors && (
                                  <div className="mt-3 max-h-56 overflow-y-auto space-y-1.5 border border-amber-200/80 rounded-lg p-2.5 bg-white">
                                    {issues.map((iss, iIdx) => (
                                      <div 
                                        key={iss.id || iIdx}
                                        className="text-xs flex items-center justify-between p-1.5 rounded hover:bg-slate-50 border-b border-slate-100 last:border-b-0"
                                      >
                                        <div className="flex items-center gap-2 truncate">
                                          <span className="font-mono text-[11px] text-slate-400">#{iIdx + 1}</span>
                                          <span className="font-semibold text-slate-800">{iss.column}</span>
                                          <span className="text-slate-500 truncate text-[11px]">— {iss.description}</span>
                                        </div>
                                        <span className="px-2 py-0.5 rounded text-[10px] font-bold capitalize bg-amber-100 text-amber-800 shrink-0">
                                          {iss.category.replace(/_/g, ' ')}
                                        </span>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
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
