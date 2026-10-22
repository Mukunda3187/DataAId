import React, { useState, useCallback } from 'react';
import { 
  Wrench, 
  Check, 
  X, 
  Edit3, 
  Eye, 
  Trash2, 
  FileSpreadsheet, 
  ListFilter,
  Undo2,
  Redo2,
  ChevronDown,
  ScanSearch
} from 'lucide-react';
import { CorrectionItem, QualityIssue, ColumnProfile } from '../types/dataQuality';
import { DiffPreviewModal } from '../components/DiffPreviewModal';

interface CorrectionCenterPageProps {
  corrections: CorrectionItem[];
  issues: QualityIssue[];
  rawRows?: Record<string, any>[] | null;
  columns?: ColumnProfile[] | null;
  onUpdateCorrection: (params: {
    correctionId?: string;
    status?: 'pending' | 'approved' | 'rejected';
    editedValue?: any;
    bulkAction?: 'approve_all' | 'reject_all' | 'approve_safe' | 'approve_column' | 'reject_column' | 'reexamine_dates' | 'restore_snapshot';
    columnName?: string;
    correctedRows?: { rowRef: number; value: string }[];
    snapshot?: any;
  }) => Promise<void>;
  onDeleteRow?: (rowRef: number) => Promise<void>;
  onApplyApproved: (approveAll?: boolean) => Promise<void>;
  onRescan: () => Promise<void>;
  isApplying: boolean;
}

export const CorrectionCenterPage: React.FC<CorrectionCenterPageProps> = ({
  corrections,
  issues,
  rawRows = [],
  columns = [],
  onUpdateCorrection,
  onDeleteRow,
  onApplyApproved,
  onRescan,
  isApplying
}) => {
  const [viewMode, setViewMode] = useState<'dataset_table' | 'rules_list'>('dataset_table');
  const [rowFilter, setRowFilter] = useState<'all' | 'issues_only' | 'clean_only'>('all');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState<string>('');
  const [showDiffModal, setShowDiffModal] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [fetchedAlternates, setFetchedAlternates] = useState<Record<string, string[]>>({});

  const [columnDropdownOpen, setColumnDropdownOpen] = useState<string | null>(null);
  const columnDropdownRef = React.useRef<HTMLDivElement | null>(null);

  // Undo/redo snapshots include the complete dataset and issue/correction state.
  // This is necessary because deleting a row regenerates issue and correction IDs.
  type FullSnapshot = {
    rawRows: Record<string, any>[];
    cleanedRows: Record<string, any>[];
    corrections: CorrectionItem[];
    issues: QualityIssue[];
    columns: ColumnProfile[];
    summary: any;
  };
  const [undoStack, setUndoStack] = useState<FullSnapshot[]>([]);
  const [redoStack, setRedoStack] = useState<FullSnapshot[]>([]);

  const makeSnapshot = useCallback((): FullSnapshot => ({
    rawRows: JSON.parse(JSON.stringify(rawRows || [])),
    cleanedRows: JSON.parse(JSON.stringify(rawRows || [])),
    corrections: JSON.parse(JSON.stringify(corrections || [])),
    issues: JSON.parse(JSON.stringify(issues || [])),
    columns: JSON.parse(JSON.stringify(columns || [])),
    summary: { rowCount: (rawRows || []).length },
  }), [rawRows, corrections, issues, columns]);

  const takeSnapshot = useCallback(() => {
    const snapshot = makeSnapshot();
    setUndoStack(prev => [...prev.slice(-49), snapshot]);
    setRedoStack([]);
  }, [makeSnapshot]);

  const handleUndo = async () => {
    if (undoStack.length === 0) return;
    const previous = undoStack[undoStack.length - 1];
    setRedoStack(stack => [...stack, makeSnapshot()]);
    setUndoStack(stack => stack.slice(0, -1));
    await onUpdateCorrection({ bulkAction: 'restore_snapshot', snapshot: previous });
  };

  const handleRedo = async () => {
    if (redoStack.length === 0) return;
    const next = redoStack[redoStack.length - 1];
    setUndoStack(stack => [...stack, makeSnapshot()]);
    setRedoStack(stack => stack.slice(0, -1));
    await onUpdateCorrection({ bulkAction: 'restore_snapshot', snapshot: next });
  };

  const handleUpdateWithHistory = useCallback((params: Parameters<typeof onUpdateCorrection>[0]) => {
    takeSnapshot();
    return onUpdateCorrection(params);
  }, [onUpdateCorrection, takeSnapshot]);

  const safeRawRows = rawRows || [];
  const safeColumns = columns || [];

  const approvedCount = corrections.filter(c => c.status === 'approved').length;

  // Filter out resolved issues: rejected, approved, and applied should not show as active issues
  const activeIssues = issues.filter(i =>
    i.resolutionStatus !== 'rejected' &&
    i.resolutionStatus !== 'approved' &&
    i.resolutionStatus !== 'applied'
  );

  // Set of column names that have active issues
  const issueColumnsSet = new Set<string>();
  activeIssues.forEach(i => {
    const relCorrections = corrections.filter(c => c.issueId === i.id);
    const isAllDealt = relCorrections.length > 0 &&
      relCorrections.every(c => c.status === 'rejected' || c.status === 'approved' || c.status === 'applied');
    if (!isAllDealt && i.column && i.column !== 'All Columns (Full Record)') {
      issueColumnsSet.add(i.column);
    }
  });

  // Map of 1-based row numbers to active issues affecting that row
  const rowIssuesMap = new Map<number, QualityIssue[]>();
  // Map of `${rowNum}_${columnName}` to the issue and correction
  const cellIssueMap = new Map<string, { issue: QualityIssue; correction?: CorrectionItem }>();
  // Set of duplicate row indices (1-based)
  const duplicateRowNumbers = new Set<number>();

  activeIssues.forEach(iss => {
    iss.affectedRows.forEach(rowRef => {
      const relCorrection = corrections.find(c => c.issueId === iss.id && c.rowRef === rowRef);
      // Skip if this correction is already dealt with (rejected, approved, or applied)
      if (relCorrection && (
        relCorrection.status === 'rejected' ||
        relCorrection.status === 'approved' ||
        relCorrection.status === 'applied'
      )) {
        return;
      }

      const list = rowIssuesMap.get(rowRef) || [];
      list.push(iss);
      rowIssuesMap.set(rowRef, list);

      if (iss.category === 'duplicate_record') {
        duplicateRowNumbers.add(rowRef);
      }

      cellIssueMap.set(`${rowRef}_${iss.column}`, { issue: iss, correction: relCorrection });
    });
  });

  const colHeaders = safeColumns.length > 0 
    ? safeColumns.map(c => c.name) 
    : safeRawRows.length > 0 
      ? Object.keys(safeRawRows[0]) 
      : [];

  // When pencil button is clicked: open empty box to type
  const handleStartEdit = (correction: CorrectionItem) => {
    setEditingId(correction.id);
    setEditingText(''); // Empty box ready for custom typing
  };

  // When right button (Check) is clicked: auto approve immediately without asking again
  // CRITICAL: Missing values must NOT allow empty after approve!
  const handleSaveEditAndApprove = (correctionId: string) => {
    const trimmed = editingText.trim();
    if (!trimmed) {
      return; // Do NOT allow empty value to be approved
    }
    
    handleUpdateWithHistory({
      correctionId,
      editedValue: trimmed,
      status: 'approved' // Automatically approve and place in missing value
    });
    setEditingId(null);
    setEditingText('');
  };

  // User selects an AI alternate word: immediately approves and places it in missing value
  const handleSelectAlternateAndApprove = (corId: string, alternateVal: string) => {
    handleUpdateWithHistory({
      correctionId: corId,
      editedValue: alternateVal,
      status: 'approved' // Placed in place of missing value
    });
  };

  // Delete duplicate row directly
  const handleDeleteDuplicateRow = async (rowRef: number) => {
    if (onDeleteRow) {
      takeSnapshot();
      await onDeleteRow(rowRef);
    } else {
      const dupCorrection = corrections.find(
        c => c.rowRef === rowRef && (c.proposedValue === 'DROP_ROW' || c.column === 'Entire Row' || c.column === 'All Columns (Full Record)')
      );
      if (dupCorrection) {
        handleUpdateWithHistory({
          correctionId: dupCorrection.id,
          status: 'approved'
        });
      }
    }
  };

  // Get alternate suggestions for a missing value correction
  const getAlternates = (cor: CorrectionItem, issue?: QualityIssue): string[] => {
    if (fetchedAlternates[cor.id] && fetchedAlternates[cor.id].length > 0) {
      return fetchedAlternates[cor.id];
    }
    if (cor.alternateSuggestions && cor.alternateSuggestions.length > 0) {
      return cor.alternateSuggestions;
    }
    if (issue?.alternateSuggestions && issue.alternateSuggestions.length > 0) {
      return issue.alternateSuggestions;
    }
    return [];
  };

  // Generate clear problem statements and concise one-line reasons
  const getDetailedReason = (item: CorrectionItem): { problem: string; reason: string } => {
    const issue = issues.find(i => i.id === item.issueId);
    const orig = String(item.originalValue ?? '');
    const proposed = String(item.editedValue ?? item.proposedValue ?? '');

    if (item.proposedValue === 'DROP_ROW' || issue?.category === 'duplicate_record') {
      return {
        problem: `Duplicate Record in Row #${item.rowRef}.`,
        reason: 'Removes duplicate row to ensure record uniqueness.'
      };
    }

    if (issue?.category === 'missing_value' || orig.trim() === '') {
      return {
        problem: `Missing value in column "${item.column}".`,
        reason: `Fills empty cell with contextual AI word "${proposed || 'Standard'}".`
      };
    }

    if (issue?.category === 'inconsistent_category') {
      return {
        problem: `Inconsistent category "${orig}" in "${item.column}".`,
        reason: `Normalizes variant "${orig}" to canonical category "${proposed}".`
      };
    }

    if (issue?.category === 'invalid_format') {
      if (/date/i.test(item.column)) {
        return {
          problem: `Invalid date format in "${item.column}".`,
          reason: 'Converts non-standard date to ISO format (YYYY-MM-DD).'
        };
      }
      return {
        problem: `Invalid format in "${item.column}".`,
        reason: `Normalizes value to standard format "${proposed}".`
      };
    }

    if (issue?.category === 'business_rule_violation') {
      return {
        problem: `Value violates rule in "${item.column}".`,
        reason: `Adjusts out-of-range value to policy threshold "${proposed}".`
      };
    }

    if (issue?.category === 'potential_outlier') {
      return {
        problem: `Statistical outlier "${orig}" in "${item.column}".`,
        reason: `Replaces statistical outlier with median value "${proposed}".`
      };
    }

    return {
      problem: `Data anomaly in "${item.column}".`,
      reason: item.reason ? item.reason.split('.')[0] : 'Corrects anomaly to ensure dataset schema compliance.'
    };
  };

  // Filtered rows for the dataset table
  const displayedRows = safeRawRows.map((row, idx) => ({
    rowNum: idx + 1,
    data: row,
    hasIssue: rowIssuesMap.has(idx + 1),
    isDuplicate: duplicateRowNumbers.has(idx + 1)
  })).filter(r => {
    if (rowFilter === 'issues_only') return r.hasIssue;
    if (rowFilter === 'clean_only') return !r.hasIssue;
    return true;
  });

  // Filtered list for rules list
  const filteredCorrections = corrections.filter(c => {
    if (statusFilter === 'all') return true;
    return c.status === statusFilter;
  });

  return (
    <div className="space-y-6">
      {/* Top Banner & Control Bar: Theme #086288, #4D8DBA, #97D7FF, #FFEFC4 */}
      <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-xs flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
            <Wrench className="w-5 h-5 text-[#086288]" />
            Correction Center
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Review AI suggestions, modify missing values, and deduplicate duplicate rows.
          </p>
        </div>

        {/* Action Buttons */}
        <div className="flex flex-wrap items-center gap-2.5">
          <button
            onClick={() => onApplyApproved(true)}
            disabled={isApplying}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#086288] hover:bg-[#053b53] text-xs font-bold text-white transition cursor-pointer shadow-xs disabled:opacity-50"
          >
            <Check className="w-4 h-4 text-[#97D7FF]" />
            <span>{isApplying ? 'Creating Updated Dataset...' : 'Approve All'}</span>
          </button>

          <button
            onClick={() => handleUpdateWithHistory({ bulkAction: 'reject_all' })}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#FFEFC4] hover:bg-[#FFEFC4]/80 text-xs font-bold text-[#086288] border border-[#086288]/20 transition cursor-pointer shadow-2xs"
          >
            <X className="w-4 h-4 text-[#086288]" />
            <span>Reject All</span>
          </button>

          <button
            onClick={() => setShowDiffModal(true)}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#4D8DBA] hover:bg-[#086288] text-white text-xs font-bold shadow-xs transition cursor-pointer"
          >
            <Eye className="w-4 h-4 text-[#97D7FF]" />
            <span>View & Approve Changes</span>
          </button>

          <button
            onClick={onRescan}
            disabled={isApplying}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-900 text-white text-xs font-bold shadow-xs transition cursor-pointer disabled:opacity-50"
            title="Re-scan dataset for new issues after applying corrections"
          >
            <ScanSearch className="w-4 h-4 text-slate-300" />
            <span>Rescan</span>
          </button>
        </div>
      </div>

      {/* View Switcher and Filters */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-2">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setViewMode('dataset_table')}
            className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-bold rounded-lg transition cursor-pointer ${
              viewMode === 'dataset_table'
                ? 'bg-[#086288] text-white shadow-xs'
                : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-50'
            }`}
          >
            <FileSpreadsheet className="w-4 h-4" />
            <span>Complete Dataset Table</span>
          </button>

          <button
            onClick={() => setViewMode('rules_list')}
            className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-bold rounded-lg transition cursor-pointer ${
              viewMode === 'rules_list'
                ? 'bg-[#086288] text-white shadow-xs'
                : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-50'
            }`}
          >
            <ListFilter className="w-4 h-4" />
            <span>Corrections List ({corrections.length})</span>
          </button>
        </div>

        {viewMode === 'dataset_table' && (
          <div className="flex items-center gap-2 text-xs">
            <span className="text-slate-500 font-medium">Filter Rows:</span>
            {(['all', 'issues_only', 'clean_only'] as const).map(filter => (
              <button
                key={filter}
                onClick={() => setRowFilter(filter)}
                className={`px-2.5 py-1 rounded text-xs capitalize transition cursor-pointer ${
                  rowFilter === filter
                    ? 'bg-[#086288] text-white font-bold'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                {filter.replace('_', ' ')}
              </button>
            ))}
            {/* Undo / Redo */}
            <div className="flex items-center gap-1 ml-2 border-l border-slate-200 pl-2">
              <button
                onClick={handleUndo}
                disabled={undoStack.length === 0}
                title="Undo last correction change"
                className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-bold transition ${
                  undoStack.length === 0
                    ? 'text-slate-300 cursor-not-allowed'
                    : 'text-slate-500 hover:text-[#086288] hover:bg-slate-100 cursor-pointer'
                }`}
              >
                <Undo2 className="w-3.5 h-3.5" />
                <span>Undo</span>
              </button>
              <button
                onClick={handleRedo}
                disabled={redoStack.length === 0}
                title="Redo last undone change"
                className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-bold transition ${
                  redoStack.length === 0
                    ? 'text-slate-300 cursor-not-allowed'
                    : 'text-slate-500 hover:text-[#086288] hover:bg-slate-100 cursor-pointer'
                }`}
              >
                <Redo2 className="w-3.5 h-3.5" />
                <span>Redo</span>
              </button>
            </div>
          </div>
        )}

        {viewMode === 'rules_list' && (
          <div className="flex items-center gap-1.5 text-xs">
            {(['all', 'pending', 'approved', 'applied', 'rejected'] as const).map(status => (
              <button
                key={status}
                onClick={() => setStatusFilter(status)}
                className={`px-2.5 py-1 rounded text-xs capitalize transition cursor-pointer ${
                  statusFilter === status
                    ? 'bg-[#086288] text-white font-bold'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                {status}
              </button>
            ))}
            {/* Undo / Redo */}
            <div className="flex items-center gap-1 ml-2 border-l border-slate-200 pl-2">
              <button
                onClick={handleUndo}
                disabled={undoStack.length === 0}
                title="Undo last correction change"
                className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-bold transition ${
                  undoStack.length === 0
                    ? 'text-slate-300 cursor-not-allowed'
                    : 'text-slate-500 hover:text-[#086288] hover:bg-slate-100 cursor-pointer'
                }`}
              >
                <Undo2 className="w-3.5 h-3.5" />
                <span>Undo</span>
              </button>
              <button
                onClick={handleRedo}
                disabled={redoStack.length === 0}
                title="Redo last undone change"
                className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-bold transition ${
                  redoStack.length === 0
                    ? 'text-slate-300 cursor-not-allowed'
                    : 'text-slate-500 hover:text-[#086288] hover:bg-slate-100 cursor-pointer'
                }`}
              >
                <Redo2 className="w-3.5 h-3.5" />
                <span>Redo</span>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* VIEW 1: COMPLETE DATASET WITH EVERY ROW SHOWN */}
      {viewMode === 'dataset_table' && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-xs overflow-hidden">
          <div className="overflow-x-auto max-h-[65vh]">
            <table className="w-full text-xs text-left border-collapse">
              <thead className="sticky top-0 z-10 border-b border-slate-200">
                <tr>
                  <th className="py-2.5 px-3 bg-slate-200 text-slate-800 w-24 text-center font-bold">
                    Row #
                  </th>
                  {colHeaders.map(col => {
                    const isIssueCol = issueColumnsSet.has(col);
                    return (
                      <th
                        key={col}
                        className={`py-2.5 px-3 whitespace-nowrap font-bold ${
                          isIssueCol
                            ? 'bg-[#FFEFC4]/70 text-slate-900 border-b-2 border-[#4D8DBA]'
                            : 'bg-slate-100 text-slate-700'
                        }`}
                      >
                        <div className="flex items-center gap-1.5">
                          <span>{col}</span>
                          {isIssueCol && (
                            <span className="text-[10px] font-bold px-1.5 py-0.2 rounded bg-[#FFEFC4] text-[#086288] border border-[#086288]/20">
                              Issue
                            </span>
                          )}
                          {isIssueCol && (
                            <div className="relative" ref={columnDropdownOpen === col ? columnDropdownRef : null}>
                              <button
                                onClick={e => {
                                  e.stopPropagation();
                                  setColumnDropdownOpen(prev => prev === col ? null : col);
                                }}
                                className="p-0.5 rounded hover:bg-[#097DBA]/20 text-[#086288] transition cursor-pointer"
                                title={`Approve or reject all issues in column "${col}"`}
                              >
                                <ChevronDown className="w-3.5 h-3.5" />
                              </button>
                              {columnDropdownOpen === col && (
                                <div
                                  className="absolute left-0 top-full mt-1 z-50 bg-white border border-slate-200 rounded-lg shadow-lg min-w-[180px] py-1 font-sans font-normal text-left"
                                  onMouseLeave={() => setColumnDropdownOpen(null)}
                                >
                                  <button
                                    onMouseDown={e => {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      takeSnapshot();
                                      handleUpdateWithHistory({ bulkAction: 'approve_column', columnName: col });
                                      setColumnDropdownOpen(null);
                                    }}
                                    className="w-full text-left px-3 py-2 text-xs hover:bg-emerald-50 text-emerald-700 font-semibold transition cursor-pointer flex items-center gap-2"
                                  >
                                    <Check className="w-3.5 h-3.5" />
                                    Approve all in column
                                  </button>
                                  <button
                                    onMouseDown={e => {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      takeSnapshot();
                                      handleUpdateWithHistory({ bulkAction: 'reject_column', columnName: col });
                                      setColumnDropdownOpen(null);
                                    }}
                                    className="w-full text-left px-3 py-2 text-xs hover:bg-rose-50 text-rose-700 font-semibold transition cursor-pointer flex items-center gap-2"
                                  >
                                    <X className="w-3.5 h-3.5" />
                                    Reject all in column
                                  </button>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 font-mono">
                {displayedRows.length === 0 ? (
                  <tr>
                    <td colSpan={colHeaders.length + 1} className="py-12 text-center text-slate-400 font-sans">
                      No rows match the selected filter.
                    </td>
                  </tr>
                ) : (
                  displayedRows.map(rowObj => {
                    const rowNum = rowObj.rowNum;
                    const rowHasIssue = rowObj.hasIssue;
                    const isDuplicate = rowObj.isDuplicate;

                    const rowBgClass = isDuplicate
                      ? 'bg-rose-50/80 border-y border-rose-200'
                      : rowHasIssue
                        ? 'bg-[#FFEFC4]/25'
                        : 'hover:bg-slate-50/60';

                    return (
                      <tr key={`row-${rowNum}`} className={`${rowBgClass} transition`}>
                        {/* Row # and beside duplicate column row number there is a DELETE BUTTON */}
                        <td className={`py-2.5 px-3 text-center font-sans font-bold border-r border-slate-200/60 ${
                          isDuplicate 
                            ? 'bg-rose-100/90 text-rose-800' 
                            : rowHasIssue 
                              ? 'bg-[#FFEFC4]/40 text-slate-900' 
                              : 'bg-slate-50 text-slate-500'
                        }`}>
                          <div className="flex items-center justify-center gap-1.5 flex-wrap">
                            <span>#{rowNum}</span>
                            {/* Delete button beside duplicate row number — icon only, no text */}
                            {isDuplicate && (
                              <button
                                onClick={() => handleDeleteDuplicateRow(rowNum)}
                                className="inline-flex items-center justify-center w-6 h-6 rounded bg-rose-600 hover:bg-rose-700 text-white shadow-2xs transition cursor-pointer"
                                title="Delete duplicate row"
                              >
                                <Trash2 className="w-3 h-3" />
                              </button>
                            )}
                          </div>
                        </td>

                        {/* Cells: Show EVERY row column */}
                        {colHeaders.map(col => {
                          const cellData = cellIssueMap.get(`${rowNum}_${col}`);
                          const val = rowObj.data[col];
                          const isBlank = val === null || val === undefined || (typeof val === 'string' && val.trim() === '');
                          const rawDisplay = isBlank ? '(empty)' : String(val);

                          // If this cell has a detected specific issue and is NOT rejected
                          if (cellData && !isDuplicate) {
                            const cor = cellData.correction;
                            const isEditing = cor && editingId === cor.id;
                            const proposed = cor ? (cor.editedValue !== undefined ? cor.editedValue : cor.proposedValue) : cellData.issue.proposedValue;
                            const isApproved = cor?.status === 'approved';
                            const isMissingValue = cellData.issue.category === 'missing_value';
                            const alternates = cor ? getAlternates(cor, cellData.issue) : [];

                            return (
                              <td 
                                key={col} 
                                className={`py-2 px-3 whitespace-nowrap border border-[#4D8DBA]/30 text-slate-900 ${
                                  isApproved 
                                    ? 'bg-emerald-50/40' 
                                    : 'bg-[#FFEFC4]/35'
                                }`}
                              >
                                {isEditing && cor ? (
                                  <div className="space-y-1.5">
                                    <div className="flex items-center gap-1">
                                      {/* Empty box ready to type */}
                                      <input
                                        type="text"
                                        value={editingText}
                                        onChange={e => setEditingText(e.target.value)}
                                        placeholder={String(cor.editedValue !== undefined ? cor.editedValue : cor.proposedValue || 'Type alternate text...')}
                                        autoFocus
                                        className="px-2 py-1 text-xs bg-white border-2 border-[#086288] rounded-md font-sans w-36 focus:outline-none shadow-2xs text-slate-900"
                                      />
                                      {/* Right button: clicking approves automatically and places in missing value without asking again */}
                                      {/* DISABLED when box is empty! Enabled ONLY when box is filled! */}
                                      {(() => {
                                        const isBoxEmpty = !editingText || editingText.trim() === '';
                                        return (
                                          <button
                                            onClick={() => !isBoxEmpty && handleSaveEditAndApprove(cor.id)}
                                            disabled={isBoxEmpty}
                                            className={`p-1 rounded transition shadow-2xs ${
                                              isBoxEmpty
                                                ? 'bg-slate-200 text-slate-400 cursor-not-allowed opacity-50 border border-slate-300'
                                                : 'bg-[#086288] text-white hover:bg-[#053b53] cursor-pointer'
                                            }`}
                                            title={isBoxEmpty ? "Approve button disabled: box is empty, type a value to enable" : "Approve & Place in missing value"}
                                          >
                                            <Check className={`w-3.5 h-3.5 ${isBoxEmpty ? 'text-slate-400' : 'text-[#97D7FF]'}`} />
                                          </button>
                                        );
                                      })()}
                                      <button
                                        onClick={() => {
                                          setEditingId(null);
                                          setEditingText('');
                                        }}
                                        className="p-1 rounded bg-slate-200 text-slate-700 hover:bg-slate-300 cursor-pointer transition"
                                        title="Cancel"
                                      >
                                        <X className="w-3.5 h-3.5" />
                                      </button>
                                    </div>

                                    {(!editingText || editingText.trim() === '') && (
                                      <span className="text-[10px] text-amber-700 font-medium font-sans block">
                                        * Box must be filled to enable approve
                                      </span>
                                    )}

                                    {/* Quick clickable alternates while editing */}
                                    {alternates.length > 0 && (
                                      <div className="flex items-center gap-1 flex-wrap">
                                        <span className="text-[10px] text-slate-500 font-medium font-sans">AI Alternates:</span>
                                        {alternates.slice(0, 4).map(alt => (
                                          <button
                                            key={alt}
                                            type="button"
                                            onClick={() => setEditingText(alt)}
                                            className="text-[10px] px-1.5 py-0.2 rounded bg-white hover:bg-[#97D7FF]/30 text-[#086288] border border-[#97D7FF] cursor-pointer font-sans"
                                          >
                                            {alt}
                                          </button>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                ) : isApproved ? (
                                  /* AFTER APPROVING: show value cleanly with pencil to edit — no badge */
                                  <div className="flex items-center justify-between gap-2 py-0.5 w-full">
                                    <span className="font-semibold text-slate-900 font-sans text-xs">
                                      {String(proposed || '')}
                                    </span>
                                    {cor && (
                                      <button
                                        onClick={() => handleStartEdit(cor)}
                                        className="p-1 rounded text-slate-400 hover:text-[#086288] hover:bg-slate-100 transition cursor-pointer"
                                        title="Edit value"
                                      >
                                        <Edit3 className="w-3.5 h-3.5 text-[#086288]" />
                                      </button>
                                    )}
                                  </div>
                                ) : (
                                  /* Pending state: show AI alternate suggestion, pencil icon to edit, and approve button to place */
                                  <div className="space-y-1.5">
                                    <div className="flex items-center gap-1.5 flex-wrap">
                                      <span className="line-through text-slate-400 font-normal">
                                        {rawDisplay}
                                      </span>
                                      <span className="text-[#086288] font-bold font-sans">&rarr;</span>
                                      <span className="font-bold text-[#086288] bg-white px-2 py-0.5 rounded border border-[#97D7FF] shadow-2xs font-mono text-xs">
                                        {String(proposed || '')}
                                      </span>
                                      {/* Pencil button to edit that AI provided alternate text */}
                                      {cor && (
                                        <button
                                          onClick={() => handleStartEdit(cor)}
                                          className="p-1 rounded text-slate-400 hover:text-[#086288] hover:bg-white transition cursor-pointer"
                                          title="Edit alternate text"
                                        >
                                          <Edit3 className="w-3.5 h-3.5 text-[#086288]" />
                                        </button>
                                      )}
                                    </div>

                                    {/* Action buttons: approve to place, or reject */}
                                    {cor && (() => {
                                      const isProposedEmpty = isMissingValue && (!proposed || String(proposed).trim() === '');
                                      return (
                                        <div className="flex items-center gap-1 font-sans pt-0.5">
                                          <button
                                            onClick={() => !isProposedEmpty && handleUpdateWithHistory({
                                              correctionId: cor.id,
                                              status: 'approved'
                                            })}
                                            disabled={isProposedEmpty}
                                            className={`px-2 py-0.5 rounded text-[10px] font-bold transition shadow-2xs flex items-center gap-1 ${
                                              isProposedEmpty
                                                ? 'bg-slate-200 text-slate-400 cursor-not-allowed opacity-50 border border-slate-300'
                                                : 'bg-[#086288] text-white hover:bg-[#053b53] cursor-pointer'
                                            }`}
                                            title={isProposedEmpty ? "Approve button disabled: value is empty. Please edit with pencil." : "Approve and place this alternate text in missing value"}
                                          >
                                            <Check className={`w-3 h-3 ${isProposedEmpty ? 'text-slate-400' : 'text-[#97D7FF]'}`} />
                                            <span>Approve</span>
                                          </button>

                                          <button
                                            onClick={() => handleUpdateWithHistory({
                                              correctionId: cor.id,
                                              status: 'rejected'
                                            })}
                                            className="px-2 py-0.5 rounded text-[10px] font-bold bg-white text-slate-600 border border-slate-300 hover:bg-rose-50 hover:text-rose-700 transition cursor-pointer"
                                            title="Reject (will not be considered as an issue)"
                                          >
                                            Reject
                                          </button>
                                        </div>
                                      );
                                    })()}
                                  </div>
                                )}
                              </td>
                            );
                          }

                          // If this row is a duplicate record: SHOW THE CELL VALUES IN LIGHT RED!
                          if (isDuplicate) {
                            return (
                              <td 
                                key={col} 
                                className="py-2.5 px-3 whitespace-nowrap bg-rose-50/90 text-rose-950 border border-rose-200/80 font-mono"
                              >
                                <span>{rawDisplay}</span>
                              </td>
                            );
                          }

                          // Clean Cell
                          return (
                            <td key={col} className="py-2 px-3 whitespace-nowrap text-slate-800">
                              {rawDisplay}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* VIEW 2: CORRECTIONS LIST */}
      {viewMode === 'rules_list' && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-xs overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left">
              <thead className="bg-slate-50 text-slate-700 font-bold border-b border-slate-200 uppercase tracking-wider text-[11px]">
                <tr>
                  <th className="py-3 px-4">Row #</th>
                  <th className="py-3 px-4">Column</th>
                  <th className="py-3 px-4">Original Value</th>
                  <th className="py-3 px-4">Proposed Clean Value</th>
                  <th className="py-3 px-4">Reasons</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredCorrections.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-12 text-center text-slate-400">
                      No corrections match this filter.
                    </td>
                  </tr>
                ) : (
                  filteredCorrections.map(item => {
                    const isEditing = editingId === item.id;
                    const finalVal = item.editedValue !== undefined ? item.editedValue : item.proposedValue;
                    const isDrop = finalVal === 'DROP_ROW';
                    const isDuplicate = duplicateRowNumbers.has(item.rowRef) || isDrop;
                    const { problem, reason } = getDetailedReason(item);
                    const isMissing = item.originalValue === '' || item.originalValue === null || item.originalValue === undefined;
                    const alternates = getAlternates(item);
                    const isApproved = item.status === 'approved';

                    return (
                      <tr 
                        key={item.id} 
                        className={`transition ${isDuplicate ? 'bg-rose-50/80 border-y border-rose-200' : 'hover:bg-slate-50'}`}
                      >
                        <td className={`py-3 px-4 font-mono font-bold ${isDuplicate ? 'text-rose-700 bg-rose-100/70' : 'text-slate-900'}`}>
                          <div className="flex items-center gap-2 flex-wrap">
                            <span>#{item.rowRef}</span>
                            {/* Delete button — icon only, no text */}
                            {isDuplicate && (
                              <button
                                onClick={() => handleDeleteDuplicateRow(item.rowRef)}
                                className="inline-flex items-center justify-center w-6 h-6 rounded bg-rose-600 hover:bg-rose-700 text-white shadow-2xs transition cursor-pointer"
                                title="Delete duplicate row"
                              >
                                <Trash2 className="w-3 h-3" />
                              </button>
                            )}
                          </div>
                        </td>
                        <td className={`py-3 px-4 font-semibold ${isDuplicate ? 'text-rose-900' : 'text-slate-800'}`}>
                          {item.column}
                        </td>
                        <td className="py-3 px-4">
                          <span className={`font-mono px-2 py-0.5 rounded ${isDuplicate ? 'bg-rose-100 text-rose-950 font-semibold' : 'text-slate-600 bg-slate-100'}`}>
                            {String(item.originalValue || '(empty / null)')}
                          </span>
                        </td>
                        <td className="py-3 px-4">
                          {isEditing ? (
                            <div className="space-y-1.5">
                              <div className="flex items-center gap-1.5">
                                {/* Empty box to type */}
                                <input
                                  type="text"
                                  value={editingText}
                                  onChange={e => setEditingText(e.target.value)}
                                  placeholder="Type alternate text..."
                                  autoFocus
                                  className="px-2 py-1 text-xs border-2 border-[#086288] rounded-md focus:outline-none w-36 font-sans font-semibold bg-white shadow-2xs text-slate-900"
                                />
                                {/* Right button: approves auto without asking again and places text */}
                                {/* DISABLED when box is empty! Enabled ONLY when box is filled! */}
                                {(() => {
                                  const isBoxEmpty = !editingText || editingText.trim() === '';
                                  return (
                                    <button
                                      onClick={() => !isBoxEmpty && handleSaveEditAndApprove(item.id)}
                                      disabled={isBoxEmpty}
                                      className={`p-1 rounded transition shadow-2xs ${
                                        isBoxEmpty
                                          ? 'bg-slate-200 text-slate-400 cursor-not-allowed opacity-50 border border-slate-300'
                                          : 'bg-[#086288] text-white hover:bg-[#053b53] cursor-pointer'
                                      }`}
                                      title={isBoxEmpty ? "Approve button disabled: box is empty, type a value to enable" : "Approve & Place in dataset"}
                                    >
                                      <Check className={`w-3.5 h-3.5 ${isBoxEmpty ? 'text-slate-400' : 'text-[#97D7FF]'}`} />
                                    </button>
                                  );
                                })()}
                                <button
                                  onClick={() => {
                                    setEditingId(null);
                                    setEditingText('');
                                  }}
                                  className="p-1 rounded bg-slate-200 text-slate-700 hover:bg-slate-300 cursor-pointer transition"
                                  title="Cancel"
                                >
                                  <X className="w-3.5 h-3.5" />
                                </button>
                              </div>

                              {(!editingText || editingText.trim() === '') && (
                                <span className="text-[10px] text-amber-700 font-medium font-sans block">
                                  * Box must be filled to enable approve
                                </span>
                              )}

                              {alternates.length > 0 && (
                                <div className="flex items-center gap-1 flex-wrap">
                                  <span className="text-[10px] text-slate-500 font-medium font-sans">Suggestions:</span>
                                  {alternates.slice(0, 4).map(alt => (
                                    <button
                                      key={alt}
                                      type="button"
                                      onClick={() => setEditingText(alt)}
                                      className="text-[10px] px-1.5 py-0.2 rounded bg-slate-100 hover:bg-[#97D7FF]/30 text-slate-700 border border-slate-200 cursor-pointer font-sans"
                                    >
                                      {alt}
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                          ) : isDrop ? (
                            <span className="inline-flex items-center gap-1 font-bold text-rose-800 bg-rose-100/90 px-2 py-0.5 rounded border border-rose-300">
                              <Trash2 className="w-3.5 h-3.5 text-rose-600" /> Drop Redundant Row
                            </span>
                          ) : isApproved ? (
                            /* After approval: just show the value and pencil — no badge */
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-sans font-bold text-slate-900 text-xs">
                                {String(finalVal)}
                              </span>
                              <button
                                onClick={() => handleStartEdit(item)}
                                className="p-1 text-slate-400 hover:text-[#086288] transition cursor-pointer"
                                title="Edit value"
                              >
                                <Edit3 className="w-3.5 h-3.5 text-[#086288]" />
                              </button>
                            </div>
                          ) : (
                            <div className="space-y-1">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="font-mono font-bold text-[#086288] bg-[#97D7FF]/20 px-2 py-0.5 rounded border border-[#4D8DBA]/30 shadow-2xs">
                                  {String(finalVal)}
                                </span>
                                {/* Pencil button */}
                                <button
                                  onClick={() => handleStartEdit(item)}
                                  className="p-1 text-slate-400 hover:text-[#086288] transition cursor-pointer"
                                  title="Edit alternate text"
                                >
                                  <Edit3 className="w-3.5 h-3.5 text-[#086288]" />
                                </button>
                              </div>

                              {alternates.length > 0 && (
                                <div className="flex items-center gap-1 flex-wrap pt-0.5">
                                  <span className="text-[10px] text-slate-500 font-medium">Alternates:</span>
                                  {alternates.slice(0, 3).map(alt => (
                                    <button
                                      key={alt}
                                      type="button"
                                      onClick={() => handleSelectAlternateAndApprove(item.id, alt)}
                                      className={`text-[10px] px-1.5 py-0.5 rounded transition cursor-pointer font-medium ${
                                        finalVal === alt 
                                          ? 'bg-[#086288] text-white font-bold' 
                                          : 'bg-white hover:bg-[#97D7FF]/20 text-[#086288] border border-[#97D7FF]'
                                      }`}
                                      title={`Place "${alt}" in dataset`}
                                    >
                                      {alt}
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </td>

                        {/* REASONS COLUMN */}
                        <td className="py-3 px-4 max-w-md">
                          <div className="space-y-0.5">
                            <span className={`font-bold block text-xs ${isDuplicate ? 'text-rose-900' : 'text-slate-900'}`}>
                              {problem}
                            </span>
                            <p className={`text-[11px] leading-relaxed ${isDuplicate ? 'text-rose-800' : 'text-slate-600'}`}>
                              {reason}
                            </p>
                          </div>
                        </td>

                        {/* ACTIONS COLUMN */}
                        <td className="py-3 px-4 text-right">
                          {isDuplicate ? (
                            <button
                              onClick={() => handleDeleteDuplicateRow(item.rowRef)}
                              className="inline-flex items-center justify-center w-7 h-7 rounded bg-rose-600 hover:bg-rose-700 text-white shadow-2xs transition cursor-pointer"
                              title={`Delete duplicate row #${item.rowRef}`}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          ) : (
                            <div className="flex items-center justify-end gap-1.5">
                              {(() => {
                                const isMissing = item.column !== 'Entire Row' && (item.originalValue === '' || String(item.originalValue ?? '').trim() === '');
                                const isFinalValEmpty = !finalVal || String(finalVal).trim() === '';
                                const isApproveDisabled = item.status !== 'approved' && isMissing && isFinalValEmpty;
                                return (
                                  <button
                                    onClick={() => !isApproveDisabled && handleUpdateWithHistory({
                                      correctionId: item.id,
                                      status: item.status === 'approved' ? 'pending' : 'approved'
                                    })}
                                    disabled={isApproveDisabled}
                                    className={`p-1.5 rounded transition ${
                                      isApproveDisabled
                                        ? 'text-slate-300 bg-slate-100 cursor-not-allowed opacity-40 border border-slate-200'
                                        : item.status === 'approved'
                                          ? 'bg-[#086288] text-white shadow-2xs cursor-pointer'
                                          : 'text-slate-400 hover:text-[#086288] hover:bg-slate-100 cursor-pointer'
                                    }`}
                                    title={
                                      isApproveDisabled
                                        ? "Approve button disabled: cannot approve empty value for missing field"
                                        : item.status === 'approved' ? 'Unapprove' : 'Approve & Place in Dataset'
                                    }
                                  >
                                    <Check className="w-4 h-4" />
                                  </button>
                                );
                              })()}
                              <button
                                onClick={() => handleUpdateWithHistory({
                                  correctionId: item.id,
                                  status: item.status === 'rejected' ? 'pending' : 'rejected'
                                })}
                                className={`p-1.5 rounded transition cursor-pointer ${
                                  item.status === 'rejected'
                                    ? 'bg-rose-600 text-white shadow-2xs'
                                    : 'text-slate-400 hover:text-rose-700 hover:bg-rose-50'
                                }`}
                                title={item.status === 'rejected' ? 'Unreject' : 'Reject (will not be considered as an issue)'}
                              >
                                <X className="w-4 h-4" />
                              </button>
                            </div>
                          )}
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

      {/* Diff Preview Modal */}
      <DiffPreviewModal
        isOpen={showDiffModal}
        onClose={() => setShowDiffModal(false)}
        corrections={corrections}
        rawRows={safeRawRows}
        columns={safeColumns}
        onConfirmApply={async () => {
          await onApplyApproved(approvedCount === 0);
          setShowDiffModal(false);
        }}
        isApplying={isApplying}
      />
    </div>
  );
};
