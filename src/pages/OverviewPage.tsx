import React, { useRef, useState } from 'react';
import { 
  Database, 
  AlertTriangle, 
  CheckCircle2, 
  Copy,
  HelpCircle,
  ArrowUpRight, 
  UploadCloud,
  Wrench,
  FileSpreadsheet,
  Download,
  Columns,
  ShieldCheck
} from 'lucide-react';
import { AnalysisResult, AnalysisSettings } from '../types/dataQuality';
import { ActivePage } from '../components/Sidebar';

interface OverviewPageProps {
  currentAnalysis: AnalysisResult | null;
  onNavigate: (page: ActivePage) => void;
  onUploadDataset?: (params: {
    fileName: string;
    fileContent: string;
    fileType: 'csv' | 'xlsx';
    settings: AnalysisSettings;
    datasetName?: string;
  }) => Promise<void>;
  isUploading?: boolean;
  uploadError?: string | null;
}

export const OverviewPage: React.FC<OverviewPageProps> = ({
  currentAnalysis,
  onNavigate,
  onUploadDataset,
  isUploading = false,
  uploadError = null
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inlineFileInputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);
  const [showUploadPanel, setShowUploadPanel] = useState(false);
  const [fileSizeError, setFileSizeError] = useState<string | null>(null);

  const MAX_FILE_SIZE_MB = 300;
  const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024; // 300 MB

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  };

  const handleProcessFile = (file: File) => {
    setFileSizeError(null);

    if (file.size > MAX_FILE_SIZE_BYTES) {
      const actualMB = (file.size / (1024 * 1024)).toFixed(1);
      setFileSizeError(`File size (${actualMB} MB) exceeds the 300 MB limit.`);
      return;
    }

    if (!onUploadDataset) return;

    const fileName = file.name.toLowerCase();
    const isExcel = fileName.endsWith('.xlsx') || fileName.endsWith('.xls') || fileName.endsWith('.xlsm') ||
                    file.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
                    file.type === 'application/vnd.ms-excel';
    const isCsv = fileName.endsWith('.csv') || file.type === 'text/csv' || file.type === 'text/plain';

    const defaultSettings: AnalysisSettings = {
      detectDuplicates: true,
      detectInconsistentCategories: true,
      detectOutliers: true,
      useBusinessRules: true,
      generateGenAI: true,
      outlierSensitivity: 'standard'
    };

    if (isExcel) {
      const reader = new FileReader();
      reader.onload = async (e) => {
        const buffer = e.target?.result as ArrayBuffer;
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        const base64 = btoa(binary);
        await onUploadDataset({
          fileName: file.name,
          fileContent: base64,
          fileType: 'xlsx',
          settings: defaultSettings,
          datasetName: file.name.replace(/\.[^/.]+$/, '')
        });
        setShowUploadPanel(false);
      };
      reader.onerror = () => setFileSizeError('Failed to read Excel file. Please try again.');
      reader.readAsArrayBuffer(file);
    } else if (isCsv) {
      const reader = new FileReader();
      reader.onload = async (e) => {
        const text = e.target?.result as string;
        await onUploadDataset({
          fileName: file.name,
          fileContent: text,
          fileType: 'csv',
          settings: defaultSettings,
          datasetName: file.name.replace(/\.[^/.]+$/, '')
        });
        setShowUploadPanel(false);
      };
      reader.onerror = () => setFileSizeError('Failed to read CSV file. Please try again.');
      reader.readAsText(file);
    } else {
      setFileSizeError(`Unsupported file type "${file.name}". Please upload a CSV (.csv) or Excel (.xlsx, .xls) file.`);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleProcessFile(e.dataTransfer.files[0]);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      handleProcessFile(e.target.files[0]);
    }
  };

  // If no dataset is loaded, render clean Home "Upload Dataset" interface
  if (!currentAnalysis) {
    return (
      <div className="max-w-3xl mx-auto my-8 space-y-6">

        {/* Uploading overlay */}
        {isUploading && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm">
            <div className="bg-white rounded-2xl shadow-xl p-8 flex flex-col items-center gap-4 max-w-sm w-full mx-4">
              <div className="w-12 h-12 rounded-full border-4 border-[#086288] border-t-transparent animate-spin" />
              <p className="text-slate-800 font-bold text-base">Analyzing your dataset…</p>
              <p className="text-slate-500 text-xs text-center">Detecting missing values, duplicates, and anomalies. This may take a moment.</p>
            </div>
          </div>
        )}
        <div className="text-center space-y-2">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#97D7FF]/20 text-[#086288] text-xs font-bold mb-2">
            <span>Data Cleaning & Anomaly Correction Platform</span>
          </div>
          <h2 className="text-2xl sm:text-4xl font-extrabold text-slate-900 tracking-tight">
            Upload Your Dataset to Begin
          </h2>
          <p className="text-sm text-slate-500 max-w-lg mx-auto">
            Upload any CSV or Excel file to automatically detect missing values, duplicate records, inconsistent categories, and outliers.
          </p>
        </div>

        {/* File Size / Upload Error Alert */}
        {(fileSizeError || uploadError) && (
          <div className="p-4 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-sm flex items-start gap-3 shadow-xs">
            <AlertTriangle className="w-5 h-5 text-rose-600 shrink-0 mt-0.5" />
            <div>
              <p className="font-bold text-rose-900">Upload Error</p>
              <p className="text-xs text-rose-700 mt-0.5">{fileSizeError || uploadError}</p>
            </div>
          </div>
        )}

        {/* Upload Card */}
        <div className="bg-white rounded-2xl border border-slate-200 p-8 shadow-xs">
          <div
            onDragEnter={handleDrag}
            onDragLeave={handleDrag}
            onDragOver={handleDrag}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            className={`border-2 border-dashed rounded-2xl p-10 text-center cursor-pointer transition ${
              dragActive
                ? 'border-[#086288] bg-[#97D7FF]/15'
                : 'border-slate-300 hover:border-[#086288] bg-slate-50/60'
            }`}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.xlsx,.xls,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={handleFileChange}
              className="hidden"
            />

            <div className="w-16 h-16 rounded-2xl bg-[#97D7FF]/25 text-[#086288] flex items-center justify-center mx-auto mb-4 shadow-xs">
              <UploadCloud className="w-8 h-8" />
            </div>

            <p className="text-base font-bold text-slate-800 mb-1">
              Drag & drop your file here
            </p>
            <p className="text-xs text-slate-500 mb-4">
              Supported: CSV (.csv), Excel (.xlsx, .xls) • Maximum size: 300 MB
            </p>

            <button
              type="button"
              disabled={isUploading}
              onClick={(e) => {
                e.stopPropagation();
                fileInputRef.current?.click();
              }}
              className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-[#086288] hover:bg-[#053b53] text-white text-sm font-bold shadow-xs transition cursor-pointer"
            >
              <UploadCloud className="w-4 h-4 text-[#97D7FF]" />
              <span>{isUploading ? 'Uploading & Analyzing...' : 'Browse & Upload Dataset'}</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Summary Metrics (Excluding rejected issues so they are not considered issues)
  const totalRows = currentAnalysis.summary.rowCount;
  const activeIssues = currentAnalysis.issues.filter(i => i.resolutionStatus !== 'rejected');
  const totalIssues = activeIssues.length;
  const resolvedIssues = currentAnalysis.appliedCorrectionsCount;

  // 1. Missing Values Rows (only active)
  const missingValueIssues = activeIssues.filter(i => i.category === 'missing_value');
  const missingRowsSet = new Set<number>();
  missingValueIssues.forEach(i => i.affectedRows.forEach(r => missingRowsSet.add(r)));
  const totalMissingRows = missingRowsSet.size > 0 
    ? missingRowsSet.size 
    : currentAnalysis.columns.reduce((sum, col) => sum + col.missingCount, 0);

  // 2. Duplicate Records Rows (only active)
  const duplicateIssues = activeIssues.filter(i => i.category === 'duplicate_record');
  const duplicateRowsSet = new Set<number>();
  duplicateIssues.forEach(i => i.affectedRows.forEach(r => duplicateRowsSet.add(r)));
  const duplicateRowsCount = duplicateRowsSet.size;

  // 3. Inconsistent Categories Rows (only active)
  const inconsistentCategoryIssues = activeIssues.filter(i => i.category === 'inconsistent_category');
  const inconsistentCategoryRowsSet = new Set<number>();
  inconsistentCategoryIssues.forEach(i => i.affectedRows.forEach(r => inconsistentCategoryRowsSet.add(r)));
  const inconsistentCategoryRowsCount = inconsistentCategoryRowsSet.size;

  // Quality Score values
  const currentScoreObj = currentAnalysis.scoreAfter || currentAnalysis.scoreBefore;
  const qualityScoreVal = currentScoreObj.overall;
  const scoreDelta = currentAnalysis.scoreAfter 
    ? Number((currentAnalysis.scoreAfter.overall - currentAnalysis.scoreBefore.overall).toFixed(1))
    : null;

  const handleDownloadUpdatedDataset = () => {
    if (!currentAnalysis || !currentAnalysis.rawRows || currentAnalysis.rawRows.length === 0) return;
    const rows = currentAnalysis.rawRows;
    const headers = Object.keys(rows[0]);
    const csvContent = [
      headers.join(','),
      ...rows.map(row => 
        headers.map(h => {
          let val = row[h];
          if (val === null || val === undefined) return '';
          const str = String(val);
          if (str.includes(',') || str.includes('"') || str.includes('\n')) {
            return `"${str.replace(/"/g, '""')}"`;
          }
          return str;
        }).join(',')
      )
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    const safeName = currentAnalysis.summary.name.replace(/[^a-zA-Z0-9_-]/g, '_');
    link.setAttribute('download', `${safeName}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  // Extract only the distinct types of active errors detected in this dataset
  const detectedCategoryKeys = Array.from(new Set(activeIssues.map(i => i.category)));
  
  const categoryDefinitions: Record<string, { title: string; icon: any; color: string; bg: string; border: string }> = {
    missing_value: {
      title: 'Missing Values',
      icon: HelpCircle,
      color: 'text-amber-700',
      bg: 'bg-amber-50',
      border: 'border-amber-200'
    },
    duplicate_record: {
      title: 'Duplicate Records',
      icon: Copy,
      color: 'text-rose-700',
      bg: 'bg-rose-50',
      border: 'border-rose-200'
    },
    inconsistent_category: {
      title: 'Inconsistent Categories',
      icon: FileSpreadsheet,
      color: 'text-purple-700',
      bg: 'bg-purple-50',
      border: 'border-purple-200'
    },
    invalid_format: {
      title: 'Invalid Formats',
      icon: AlertTriangle,
      color: 'text-blue-700',
      bg: 'bg-blue-50',
      border: 'border-blue-200'
    },
    business_rule_violation: {
      title: 'Business Rule Violations',
      icon: AlertTriangle,
      color: 'text-orange-700',
      bg: 'bg-orange-50',
      border: 'border-orange-200'
    },
    potential_outlier: {
      title: 'Outliers & Anomalies',
      icon: AlertTriangle,
      color: 'text-indigo-700',
      bg: 'bg-indigo-50',
      border: 'border-indigo-200'
    }
  };

  const detectedErrorTypes = detectedCategoryKeys.map(cat => {
    return categoryDefinitions[cat] || {
      title: cat.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
      icon: AlertTriangle,
      color: 'text-slate-700',
      bg: 'bg-slate-50',
      border: 'border-slate-200'
    };
  });

  return (
    <div className="space-y-6">
      {/* Top Banner */}
      <div className="bg-gradient-to-r from-[#086288] to-[#4D8DBA] rounded-2xl p-6 text-white shadow-md relative overflow-hidden">
        <div className="relative z-10 max-w-2xl">
          <h2 className="text-xl sm:text-2xl font-extrabold tracking-tight">
            {currentAnalysis.summary.name}
          </h2>
          <p className="text-xs sm:text-sm text-white/85 mt-1 leading-relaxed">
            {currentAnalysis.summary.description}
          </p>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              onClick={() => onNavigate('corrections')}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#053b53] text-white text-xs font-semibold hover:bg-[#053b53]/80 transition border border-white/20 cursor-pointer shadow-xs"
            >
              <Wrench className="w-3.5 h-3.5 text-[#97D7FF]" />
              <span>Correction Center</span>
            </button>

            {/* Download Updated Dataset button */}
            <button
              onClick={handleDownloadUpdatedDataset}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#FFEFC4] hover:bg-[#FFEFC4]/90 text-[#086288] text-xs font-bold transition border border-[#086288]/20 shadow-xs cursor-pointer"
              title="Download the updated cleaned dataset (CSV)"
            >
              <Download className="w-3.5 h-3.5 text-[#086288]" />
              <span>Download Updated Dataset</span>
            </button>
          </div>
        </div>
      </div>

      {/* KPI Cards Row: Total Rows, Total Columns, Quality Score of dataset beside column box, Missing Values, Duplicate Records, Inconsistent Categories */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3.5 sm:gap-4">
        {/* 1. Total Rows */}
        <div className="p-4 bg-white rounded-xl border border-slate-200 shadow-xs">
          <div className="flex items-center justify-between text-slate-400 mb-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">Total Rows</span>
            <Database className="w-4 h-4 text-[#086288]" />
          </div>
          <div className="text-2xl font-extrabold text-slate-900">{totalRows.toLocaleString()}</div>
          <span className="text-[11px] text-slate-500">Dataset records</span>
        </div>

        {/* 2. Total Columns */}
        <div className="p-4 bg-white rounded-xl border border-slate-200 shadow-xs">
          <div className="flex items-center justify-between text-slate-400 mb-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">Total Columns</span>
            <Columns className="w-4 h-4 text-[#086288]" />
          </div>
          <div className="text-2xl font-extrabold text-[#086288]">{currentAnalysis.columns.length}</div>
          <span className="text-[11px] text-slate-500">Schema attributes</span>
        </div>

        {/* 3. Quality Score of Dataset (Beside Column Box!) */}
        <div className="p-4 bg-white rounded-xl border border-[#4D8DBA]/40 shadow-xs bg-gradient-to-br from-white to-[#97D7FF]/15">
          <div className="flex items-center justify-between text-slate-400 mb-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-[#086288]">Quality Score</span>
            <ShieldCheck className="w-4 h-4 text-[#086288]" />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-extrabold text-[#086288]">{qualityScoreVal}%</span>
            {scoreDelta !== null && (
              <span className={`text-[11px] font-bold px-1.5 py-0.2 rounded-full ${
                scoreDelta >= 0 ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'
              }`}>
                {scoreDelta >= 0 ? `+${scoreDelta}%` : `${scoreDelta}%`}
              </span>
            )}
          </div>
          <span className="text-[11px] text-slate-600 font-medium">Dataset quality health</span>
        </div>

        {/* 4. Missing Values */}
        <div className="p-4 bg-white rounded-xl border border-slate-200 shadow-xs">
          <div className="flex items-center justify-between text-slate-400 mb-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">Missing Values</span>
            <HelpCircle className="w-4 h-4 text-amber-500" />
          </div>
          <div className="text-2xl font-extrabold text-amber-600">{totalMissingRows.toLocaleString()} rows</div>
          <span className="text-[11px] text-slate-500">Unresolved missing cells</span>
        </div>

        {/* 5. Duplicate Records */}
        <div className="p-4 bg-white rounded-xl border border-slate-200 shadow-xs">
          <div className="flex items-center justify-between text-slate-400 mb-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">Duplicate Records</span>
            <Copy className="w-4 h-4 text-rose-500" />
          </div>
          <div className="text-2xl font-extrabold text-rose-600">{duplicateRowsCount.toLocaleString()} rows</div>
          <span className="text-[11px] text-slate-500">Redundant rows</span>
        </div>

        {/* 6. Inconsistent Categories */}
        <div className="p-4 bg-white rounded-xl border border-slate-200 shadow-xs">
          <div className="flex items-center justify-between text-slate-400 mb-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">Inconsistent Categories</span>
            <FileSpreadsheet className="w-4 h-4 text-purple-600" />
          </div>
          <div className="text-2xl font-extrabold text-purple-600">{inconsistentCategoryRowsCount.toLocaleString()} rows</div>
          <span className="text-[11px] text-slate-500">Category anomalies</span>
        </div>
      </div>

      {/* Section: Errors Detected (Between boxes and dataset columns overview - list only what errors detected not total list just types) */}
      <div className="bg-white rounded-xl border border-slate-200 p-4 sm:p-5 shadow-xs">
        <div className="flex items-center justify-between mb-3 pb-2.5 border-b border-slate-100">
          <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-500" />
            <span>Errors Detected</span>
          </h3>
          <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-slate-100 text-slate-700">
            {detectedErrorTypes.length} {detectedErrorTypes.length === 1 ? 'type detected' : 'types detected'}
          </span>
        </div>

        {detectedErrorTypes.length > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {detectedErrorTypes.map((type, idx) => {
              const IconComp = type.icon;
              return (
                <div 
                  key={idx} 
                  className={`flex items-center gap-2.5 p-3 rounded-lg border ${type.border} ${type.bg}`}
                >
                  <div className="p-1.5 rounded-md bg-white/85 shadow-2xs shrink-0">
                    <IconComp className={`w-4 h-4 ${type.color}`} />
                  </div>
                  <span className={`text-xs font-bold ${type.color}`}>{type.title}</span>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="flex items-center gap-2 text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 p-3 rounded-lg">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            <span>No errors detected in this dataset.</span>
          </div>
        )}
      </div>

      {/* Dataset Columns Overview Table */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-xs overflow-hidden">
        <div className="p-4 sm:p-5 border-b border-slate-200 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-bold text-slate-900">Dataset Columns Overview</h3>
            <p className="text-xs text-slate-500">Summary of columns, data types, missing counts, and detected issues</p>
          </div>
          <button
            onClick={() => onNavigate('corrections')}
            className="inline-flex items-center gap-1.5 text-xs font-bold text-[#086288] hover:underline"
          >
            <span>Go to Correction Center</span>
            <ArrowUpRight className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs text-left">
            <thead className="bg-slate-50 text-slate-700 font-bold border-b border-slate-200 uppercase tracking-wider text-[11px]">
              <tr>
                <th className="py-2.5 px-4">Column Name</th>
                <th className="py-2.5 px-4">Data Type</th>
                <th className="py-2.5 px-4">Non-Null Count</th>
                <th className="py-2.5 px-4">Missing Values</th>
                <th className="py-2.5 px-4">Unique Ratio</th>
                <th className="py-2.5 px-4">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {currentAnalysis.columns.map(col => (
                <tr key={col.name} className="hover:bg-slate-50 transition">
                  <td className="py-2.5 px-4 font-bold text-slate-900">{col.name}</td>
                  <td className="py-2.5 px-4">
                    <span className="font-mono text-xs px-2 py-0.5 rounded bg-slate-100 text-slate-700 font-semibold">
                      {col.dataType}
                    </span>
                  </td>
                  <td className="py-2.5 px-4 text-slate-700 font-medium">
                    {col.nonNullCount} / {currentAnalysis.summary.rowCount}
                  </td>
                  <td className="py-2.5 px-4">
                    <span className={col.missingCount > 0 ? 'text-amber-600 font-bold' : 'text-slate-500'}>
                      {col.missingCount} ({col.missingPercentage}%)
                    </span>
                  </td>
                  <td className="py-2.5 px-4 text-slate-600">
                    {col.uniquePercentage}% ({col.uniqueCount} unique)
                  </td>
                  <td className="py-2.5 px-4">
                    {col.issuesCount > 0 ? (
                      <span className="px-2 py-0.5 rounded-full font-bold bg-amber-100 text-amber-800 text-[11px]">
                        {col.issuesCount} issue{col.issuesCount > 1 ? 's' : ''}
                      </span>
                    ) : (
                      <span className="px-2 py-0.5 rounded-full font-semibold bg-emerald-100 text-emerald-800 text-[11px]">
                        Clean
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
