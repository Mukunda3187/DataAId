import React, { useState } from 'react';
import { X, CheckCircle, ArrowRight, Trash2, Edit3, ShieldAlert, Check, FileSpreadsheet, Eye } from 'lucide-react';
import { CorrectionItem, ColumnProfile } from '../types/dataQuality';

interface DiffPreviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirmApply: () => void;
  corrections: CorrectionItem[];
  rawRows?: Record<string, any>[];
  columns?: ColumnProfile[];
  isApplying: boolean;
}

export const DiffPreviewModal: React.FC<DiffPreviewModalProps> = ({
  isOpen,
  onClose,
  onConfirmApply,
  corrections,
  rawRows = [],
  columns = [],
  isApplying
}) => {
  if (!isOpen) return null;

  const [activeTab, setActiveTab] = useState<'complete_dataset' | 'changes_only'>('complete_dataset');

  const approved = corrections.filter(c => c.status === 'approved');
  const droppedRowIndices = new Set<number>();
  // Map of `${rowIdx}_${colName}` -> { before, after }
  const modifiedCellsMap = new Map<string, { before: any; after: any }>();

  approved.forEach(item => {
    const rowIdx = item.rowRef - 1;
    const finalVal = item.editedValue !== undefined ? item.editedValue : item.proposedValue;
    if (finalVal === 'DROP_ROW') {
      droppedRowIndices.add(rowIdx);
    } else {
      modifiedCellsMap.set(`${rowIdx}_${item.column}`, {
        before: item.originalValue,
        after: finalVal
      });
    }
  });

  // Build the complete preview dataset with applied corrections
  // Deep copy so rawRows is preserved
  const completePreviewRows = (rawRows || []).map((row, idx) => {
    const newRow = { ...row };
    // Check if any approved changes exist for this row
    approved.forEach(item => {
      if (item.rowRef - 1 === idx && item.proposedValue !== 'DROP_ROW') {
        const finalVal = item.editedValue !== undefined ? item.editedValue : item.proposedValue;
        newRow[item.column] = finalVal;
      }
    });
    return {
      _originalIndex: idx + 1,
      _isDropped: droppedRowIndices.has(idx),
      data: newRow
    };
  });

  // Extract column headers
  const colHeaders = columns.length > 0 
    ? columns.map(c => c.name) 
    : rawRows.length > 0 
      ? Object.keys(rawRows[0]) 
      : [];

  const finalActiveRowsCount = completePreviewRows.filter(r => !r._isDropped).length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-slate-900/60 backdrop-blur-xs overflow-y-auto">
      <div className="bg-white rounded-2xl max-w-5xl w-full shadow-2xl border border-slate-200 overflow-hidden my-4 max-h-[92vh] flex flex-col">
        {/* Header */}
        <div className="p-5 bg-[#086288] text-white flex items-center justify-between shrink-0">
          <div>
            <span className="text-[11px] uppercase font-bold tracking-wider text-[#97D7FF]">
              Dataset Clean Preview
            </span>
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              <FileSpreadsheet className="w-5 h-5 text-[#97D7FF]" />
              Complete Cleaned Dataset Preview
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-white/80 hover:text-white hover:bg-white/10 transition cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* View Tabs & KPI Strip */}
        <div className="px-6 py-3 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setActiveTab('complete_dataset')}
              className={`px-3 py-1.5 text-xs font-bold rounded-lg transition cursor-pointer ${
                activeTab === 'complete_dataset'
                  ? 'bg-[#086288] text-white shadow-xs'
                  : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-100'
              }`}
            >
              Complete Dataset View ({finalActiveRowsCount} rows)
            </button>
            <button
              onClick={() => setActiveTab('changes_only')}
              className={`px-3 py-1.5 text-xs font-bold rounded-lg transition cursor-pointer ${
                activeTab === 'changes_only'
                  ? 'bg-[#086288] text-white shadow-xs'
                  : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-100'
              }`}
            >
              Changes Only ({approved.length} transformations)
            </button>
          </div>

          <div className="flex items-center gap-3 text-xs">
            <span className="text-slate-500">
              Approved Modifications: <strong className="text-[#086288]">{modifiedCellsMap.size} cells</strong>
            </span>
            <span className="text-slate-300">&bull;</span>
            <span className="text-slate-500">
              Deduplicated Rows: <strong className="text-rose-600">{droppedRowIndices.size}</strong>
            </span>
          </div>
        </div>

        {/* Body Canvas */}
        <div className="p-6 overflow-y-auto space-y-4 flex-1 text-sm text-slate-700">
          {approved.length === 0 && (
            <div className="p-4 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 text-xs flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 shrink-0 text-amber-600" />
              <span>
                No corrections are currently approved. Showing baseline raw dataset. Approve corrections to preview transformations in green.
              </span>
            </div>
          )}

          {/* TAB 1: COMPLETE DATASET VIEW */}
          {activeTab === 'complete_dataset' && (
            <div className="border border-slate-200 rounded-xl overflow-hidden shadow-xs">
              <div className="overflow-x-auto max-h-[55vh]">
                <table className="w-full text-xs text-left border-collapse">
                  <thead className="bg-slate-100 text-slate-700 font-bold sticky top-0 z-10 border-b border-slate-200">
                    <tr>
                      <th className="py-2.5 px-3 bg-slate-200 text-slate-800 w-16 text-center">Row #</th>
                      {colHeaders.map(col => (
                        <th key={col} className="py-2.5 px-3 whitespace-nowrap">
                          {col}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 font-mono">
                    {completePreviewRows.map((rowItem) => {
                      const rowIdx = rowItem._originalIndex - 1;

                      if (rowItem._isDropped) {
                        return (
                          <tr key={`row-${rowItem._originalIndex}`} className="bg-rose-50/70 text-rose-700">
                            <td className="py-2 px-3 text-center font-bold text-rose-600 bg-rose-100/60">
                              #{rowItem._originalIndex}
                            </td>
                            <td colSpan={colHeaders.length} className="py-2 px-3 text-rose-700 italic font-sans">
                              <span className="inline-flex items-center gap-1.5 font-bold">
                                <Trash2 className="w-3.5 h-3.5 text-rose-600" />
                                Redundant duplicate row &mdash; Will be dropped from clean export
                              </span>
                            </td>
                          </tr>
                        );
                      }

                      return (
                        <tr key={`row-${rowItem._originalIndex}`} className="hover:bg-slate-50 transition">
                          <td className="py-2 px-3 text-center text-slate-400 font-sans font-semibold bg-slate-50/70 border-r border-slate-100">
                            #{rowItem._originalIndex}
                          </td>
                          {colHeaders.map(col => {
                            const isCellModified = modifiedCellsMap.has(`${rowIdx}_${col}`);
                            const val = rowItem.data[col];
                            const cellDisplay = val === null || val === undefined || val === '' ? (
                              <span className="text-slate-300 italic font-sans">(empty)</span>
                            ) : (
                              String(val)
                            );

                            return (
                              <td 
                                key={col} 
                                className={`py-2 px-3 whitespace-nowrap ${
                                  isCellModified 
                                    ? 'bg-emerald-50 text-emerald-900 font-bold border border-emerald-300' 
                                    : 'text-slate-800'
                                }`}
                              >
                                {cellDisplay}
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* TAB 2: CHANGES ONLY VIEW */}
          {activeTab === 'changes_only' && (
            <div className="border border-slate-200 rounded-xl overflow-hidden shadow-xs">
              {approved.length === 0 ? (
                <div className="p-8 text-center text-slate-400 text-xs">
                  No transformations are marked as approved yet.
                </div>
              ) : (
                <div className="overflow-x-auto max-h-[55vh]">
                  <table className="w-full text-xs text-left">
                    <thead className="bg-slate-100 text-slate-700 font-bold sticky top-0 border-b border-slate-200">
                      <tr>
                        <th className="py-2.5 px-3">Row #</th>
                        <th className="py-2.5 px-3">Column</th>
                        <th className="py-2.5 px-3">Original Value</th>
                        <th className="py-2.5 px-3">Applied Value</th>
                        <th className="py-2.5 px-3">Reason</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {approved.map(item => {
                        const finalVal = item.editedValue !== undefined ? item.editedValue : item.proposedValue;
                        const isDrop = finalVal === 'DROP_ROW';

                        return (
                          <tr key={item.id} className="hover:bg-slate-50">
                            <td className="py-2.5 px-3 font-mono font-bold text-slate-700">
                              #{item.rowRef}
                            </td>
                            <td className="py-2.5 px-3 font-semibold text-slate-900">
                              {item.column}
                            </td>
                            <td className="py-2.5 px-3">
                              <span className="font-mono text-slate-500 bg-slate-100 px-2 py-0.5 rounded">
                                {String(item.originalValue || '(empty)')}
                              </span>
                            </td>
                            <td className="py-2.5 px-3">
                              {isDrop ? (
                                <span className="inline-flex items-center gap-1 font-bold text-rose-700 bg-rose-50 px-2 py-0.5 rounded border border-rose-200">
                                  <Trash2 className="w-3 h-3" /> Drop Row
                                </span>
                              ) : (
                                <span className="font-mono font-bold text-emerald-800 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-300">
                                  {String(finalVal)}
                                </span>
                              )}
                            </td>
                            <td className="py-2.5 px-3 text-slate-600 max-w-sm truncate" title={item.reason}>
                              {item.reason}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 bg-slate-50 border-t border-slate-200 flex items-center justify-between shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-xs font-semibold text-slate-600 hover:bg-slate-200 transition cursor-pointer"
          >
            Back to Review
          </button>

          <button
            onClick={onConfirmApply}
            disabled={corrections.length === 0 || isApplying}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-[#086288] hover:bg-[#053b53] text-white text-xs font-bold shadow-md transition disabled:opacity-50 cursor-pointer"
          >
            <Check className="w-4 h-4 text-[#97D7FF]" />
            <span>
              {isApplying
                ? 'Creating Updated Dataset...'
                : approved.length > 0
                  ? `Apply & Create Updated Dataset (${approved.length} changes)`
                  : 'Approve All & Create Updated Dataset'}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
};
