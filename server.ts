import express, { Request, Response } from 'express';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
import path from 'path';
import * as XLSX from 'xlsx';

import { AnalysisResult, DatasetSummary, AnalysisSettings, BusinessRule, QualityWeights, SubsetResult, SubsetSpec } from './src/types/dataQuality';
import { profileDataset } from './src/services/profiler';
import { detectQualityIssues } from './src/services/qualityDetector';
import { calculateQualityScore, DEFAULT_WEIGHTS } from './src/services/scoringEngine';
import { generateCorrectionsFromIssues, previewCorrectionsDiff, applyApprovedCorrections } from './src/services/correctionEngine';
import { explainQualityIssueWithAI, isGeminiAvailable, generateMissingValueAlternatesAI, understandDatasetWithAI, interpretSubsetInstruction, validateCorrection, getGeminiKeyCount } from './src/services/geminiService';

dotenv.config();

import { persistentStorage } from './src/services/storage';
import { storeUploadedDataset, fileStorageStatus } from './src/services/fileStorage';
import { chatWithDatasetAI } from './src/services/geminiService';
import { applySubsetSpec, AppliedSubset } from './src/services/subsetEngine';
import { parseQuestionIntent, computeDatasetAnalytics } from './src/services/analyticsEngine';

function buildDirectDatasetAnswer(analysis: AnalysisResult, question: string) {
  const q = question.toLowerCase();
  const rows = analysis.rawRows || [];
  const cols = analysis.columns || [];
  const names = cols.map(c => c.name);
  const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, '');
  const col = names.find(n => q.includes(n.toLowerCase())) || names.find(n => norm(q).includes(norm(n)));
  const make = (answer: string, evidence: string[] = []) => ({
    answer, evidence, recommendation: null, confidence: 'High' as const,
    confidenceReason: 'Calculated directly from the uploaded dataset by backend code.',
    warnings: [], clarificationNeeded: false, provider: 'Dataset analysis',
    referencedColumns: col ? [col] : undefined, structured: true as const
  });
  const rowCount = rows.length;
  const colCount = names.length;
  const totalMissing = cols.reduce((sum, c) => sum + (c.missingCount || 0), 0);
  if (/\b(size|file size)\b/.test(q) && !/\b(row|column|dimension)\b/.test(q)) {
    const bytes = Number(analysis.summary?.fileSize || 0);
    const size = bytes ? `${(bytes / 1024 / 1024).toFixed(2)} MB (${bytes.toLocaleString()} bytes)` : `${(Buffer.byteLength(JSON.stringify(rows), 'utf8') / 1024 / 1024).toFixed(2)} MB estimated in-memory JSON size`;
    return make(`The dataset file size is ${size}.`, [`Dataset: ${analysis.summary?.name || 'Uploaded dataset'}`]);
  }
  if (/\b(rows?\s*(and|&)\s*columns?|shape|dimensions?|dataset size|how big is (the )?dataset)\b/.test(q))
    return make(`The dataset has ${rowCount.toLocaleString()} rows and ${colCount} columns (shape: ${rowCount} × ${colCount}).`, [`Rows: ${rowCount}`, `Columns: ${colCount}`]);
  if (/\b(how many|number of|total|count of)\b.*\b(rows?|records?)\b|\brow count\b/.test(q))
    return make(`The dataset contains ${rowCount.toLocaleString()} rows.`, [`Total rows: ${rowCount}`]);
  if (/\b(how many|number of|total|count of)\b.*\b(columns?|fields?|features?|variables?)\b|\bcolumn count\b/.test(q))
    return make(`The dataset contains ${colCount} columns: ${names.join(', ')}.`, [`Total columns: ${colCount}`]);
  if (/\b(list|show|what are|which are|names of)\b.*\b(columns?|fields?|features?|headers?)\b/.test(q))
    return make(`The dataset columns are: ${names.join(', ')}.`, names.map(n => `Column: ${n}`));
  if (/\bmissing|null|empty|blank\b/.test(q)) {
    const missingRowMatch = q.match(/\b(?:row|record)\s*(?:number|no\.?|#)?\s*(\d+)\b/);
    if (missingRowMatch) {
      const rowNo = Number(missingRowMatch[1]);
      if (rowNo < 1 || rowNo > rowCount) return make(`Row ${rowNo} does not exist. This dataset has ${rowCount} rows.`);
      const missingCols = names.filter(name => rows[rowNo - 1][name] === null || rows[rowNo - 1][name] === undefined || String(rows[rowNo - 1][name]).trim() === '');
      return make(missingCols.length ? `Row ${rowNo} has ${missingCols.length} missing value(s) in: ${missingCols.join(', ')}.` : `Row ${rowNo} has no missing values.`, missingCols.map(name => `${name}: missing`));
    }
    if (col) {
      const values = rows.map(r => r[col]);
      const count = values.filter(v => v === null || v === undefined || String(v).trim() === '').length;
      const pct = rowCount ? (count / rowCount * 100).toFixed(2) : '0.00';
      return make(`Column "${col}" has ${count} missing value(s) out of ${rowCount} rows (${pct}%).`, [`Missing in ${col}: ${count}`, `Rows: ${rowCount}`]);
    }
    return make(`This dataset has ${totalMissing} missing cell(s) across ${colCount} columns.\n${cols.map(c => `${c.name}: ${c.missingCount} missing (${Number(c.missingPercentage || 0).toFixed(2)}%)`).join('\n')}`, [`Total missing cells: ${totalMissing}`]);
  }
  if (col && /\b(mean|average|avg)\b/.test(q)) {
    const nums = rows.flatMap(r => { const raw = r[col]; if (raw === null || raw === undefined || String(raw).trim() === '') return []; const n = Number(raw); return Number.isFinite(n) ? [n] : []; });
    if (!nums.length) return make(`I cannot calculate a numeric mean for "${col}" because it has no valid numeric values.`, [`Column: ${col}`, `Valid numeric values: 0`]);
    const mean = nums.reduce((a,b) => a+b, 0) / nums.length;
    return make(`The mean (average) of "${col}" is ${mean.toLocaleString(undefined, {maximumFractionDigits: 4})}, calculated from ${nums.length} valid numeric values.`, [`Mean ${col}: ${mean}`, `Valid values: ${nums.length}`]);
  }
  if (col && /\b(median|minimum|min|maximum|max|unique|distinct|data type|datatype|type of|describe|explain|about)\b/.test(q)) {
    const vals = rows.map(r => r[col]).filter(v => v !== null && v !== undefined && String(v).trim() !== '');
    const numeric = vals.map(Number).filter(Number.isFinite);
    const profile = cols.find(c => c.name === col)!;
    const details = [`Data type: ${profile.dataType}`, `Non-missing values: ${vals.length}`, `Missing values: ${rowCount - vals.length}`, `Unique values: ${new Set(vals.map(String)).size}`];
    if (numeric.length) details.push(`Minimum: ${Math.min(...numeric)}`, `Maximum: ${Math.max(...numeric)}`, `Mean: ${(numeric.reduce((a,b)=>a+b,0)/numeric.length).toFixed(4)}`);
    if (/\bmedian\b/.test(q) && numeric.length) { const a=[...numeric].sort((x,y)=>x-y); const m=Math.floor(a.length/2); details.push(`Median: ${a.length%2 ? a[m] : (a[m-1]+a[m])/2}`); }
    if (/\b(unique|distinct)\b/.test(q)) details.push(`Sample unique values: ${[...new Set(vals.map(String))].slice(0,15).join(', ')}`);
    return make(`Here are the details for the "${col}" column:\n${details.join('\n')}`, details);
  }
  const rowMatch = q.match(/\b(?:row|record)\s*(?:number|no\.?|#)?\s*(\d+)\b/);
  if (rowMatch) {
    const index = Number(rowMatch[1]) - 1;
    if (index < 0 || index >= rowCount) return make(`Row ${rowMatch[1]} does not exist. This dataset has ${rowCount} rows.`);
    const row = rows[index];
    return make(`Row ${rowMatch[1]} contains:\n${names.map(n => `${n}: ${row[n] ?? '(missing)'}`).join('\n')}`, names.map(n => `${n}: ${row[n] ?? '(missing)'}`));
  }
  if (/\b(explain|describe|overview|summary|what is this dataset|tell me about this dataset|about this dataset)\b/.test(q)) {
    const totalIssues = (analysis.issues || []).length;
    return make(`Dataset overview: "${analysis.summary?.name || 'Uploaded dataset'}" contains ${rowCount} rows and ${colCount} columns.\nColumns: ${names.join(', ')}.\nTotal missing cells: ${totalMissing}.\nDetected data quality issues: ${totalIssues}.\nQuality score: ${analysis.scoreBefore?.overall ?? 'Not available'}.`, [`Rows: ${rowCount}`, `Columns: ${colCount}`, `Missing cells: ${totalMissing}`, `Detected issues: ${totalIssues}`]);
  }
  return null;
}

function generateCommitHash(): string {
  return Math.random().toString(16).substring(2, 9);
}

function buildInitialErrorsSummary(issues: any[]) {
  const catMap: Record<string, { count: number; columns: Set<string>; severity: string; title: string }> = {
    missing_value: { count: 0, columns: new Set(), severity: 'high', title: 'Missing Values' },
    duplicate_record: { count: 0, columns: new Set(), severity: 'critical', title: 'Duplicate Records' },
    inconsistent_category: { count: 0, columns: new Set(), severity: 'medium', title: 'Inconsistent Categories' },
    invalid_format: { count: 0, columns: new Set(), severity: 'high', title: 'Invalid Formats' },
    business_rule_violation: { count: 0, columns: new Set(), severity: 'high', title: 'Business Rule Violations' },
    potential_outlier: { count: 0, columns: new Set(), severity: 'low', title: 'Statistical Outliers' }
  };

  for (const iss of issues) {
    if (!catMap[iss.category]) {
      catMap[iss.category] = { count: 0, columns: new Set(), severity: iss.severity, title: iss.category.replace(/_/g, ' ') };
    }
    catMap[iss.category].count++;
    catMap[iss.category].columns.add(iss.column);
  }

  return Object.entries(catMap)
    .filter(([_, data]) => data.count > 0)
    .map(([category, data]) => ({
      category: category as any,
      title: data.title,
      count: data.count,
      columns: Array.from(data.columns),
      severity: data.severity as any
    }));
}

// ---------------------------------------------------------------------------
// Datamate intent classification.
//
// The unified /api/ai/datamate endpoint figures out whether the user wants a
// dataset subset built or a plain question answered, purely from the message
// text. This is a HEURISTIC classifier that runs identically in demo mode and
// with Gemini configured — it never calls the AI. The default is QUESTION so a
// genuine question (e.g. "which columns have missing values?") is never turned
// into a build. Build patterns are matched only when the phrasing is an
// unambiguous projection / filter / subset request.
// ---------------------------------------------------------------------------
function classifyDatamateIntent(message: string, columns: Array<{ name: string }> = []): 'build' | 'question' {
  // Explicit row-number requests are deterministic data retrieval.
  if (/\brows?\s+(?:number\s+|no\.\s*)?(?:#\s*)?\d+(?:\s*(?:,|and)\s*\d+)*\b/i.test(message)) return 'build';

  // "give/show N columns and N rows" — slice both axes
  if (/\b\d+\s+columns?\b/i.test(message) && /\b\d+\s+rows?\b/i.test(message)) return 'build';

  // "give/show N rows" with a retrieval verb — return first N rows
  if (/\b(?:give|show|get|fetch|display|return|extract|pull)\b[\s\S]{0,30}\b\d+\s+rows?\b/i.test(message)) return 'build';

  // Column-specific missing value requests: "give email rows with missing", "show rows where email is null/empty/missing"
  if (/\b(?:missing|null|empty|blank)\b/i.test(message) && /\b(?:rows?|records?|entries)\b/i.test(message)) return 'build';
  if (/\b(?:rows?|records?)\s+(?:in\s+which|where|with|that\s+have?|having)\b[\s\S]{0,40}\b(?:missing|null|empty|blank|no\s+value)\b/i.test(message)) return 'build';
  if (/\b(?:missing|null|empty|blank)\b[\s\S]{0,40}\b(?:rows?|records?|entries|exist|found)\b/i.test(message)) return 'build';

  // Retrieval verbs followed by a real dataset column mean the user wants
  // actual values/records, not a general explanation of that column.
  const asksForData = /^\s*(?:show|give|fetch|list|display|return|extract|get|download)\b/i.test(message);
  if (asksForData && columns.some(column => {
    const tokens = column.name.trim().split(/[_\s-]+/).filter(Boolean);
    if (!tokens.length) return false;
    const escaped = tokens.map(token => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return new RegExp(`\\b${escaped.join('[_\\s-]+')}\\b`, 'i').test(message);
  })) return 'build';

  // Filter patterns: "rows where ...", "only rows ...", "rows that ..."
  if (/\brows\s+where\b/i.test(message)) return 'build';
  if (/\bonly\s+rows\b/i.test(message)) return 'build';
  if (/\brows\s+that\b/i.test(message)) return 'build';
  if (/\brows\s+with\b/i.test(message)) return 'build';
  if (/\brows\s+having\b/i.test(message)) return 'build';

  // Projection: "columns name, email, revenue" — require a comma-separated list
  // so a question like "which columns have missing values?" (no comma after
  // "columns") is NOT misclassified as a build.
  if (/\bcolumns\s+[\w.]*(?:\s*,\s*[\w.]+)+/i.test(message)) return 'build';

  // Row slicing: "top/first/last N rows", "limit N", "top N products/records"
  if (/\b(?:top|first|last)\s+\d+\s+rows?\b/i.test(message)) return 'build';
  if (/\b(?:top|first|last)\s+\d+\s+(?:products?|records?|entries|items|results?|customers?|sales?|highest|lowest)\b/i.test(message)) return 'build';
  if (/\blimit\s+\d+\b/i.test(message)) return 'build';

  // Explicit subset keywords
  if (/\b(?:subset|sub\s*dataset|sub-dataset|custom\s+dataset)\b/i.test(message)) return 'build';

  // Verb + dataset/subset within a short window: "create a dataset", "build a subset", "give me a subset"
  if (/\b(?:create|build|make|generate|extract|give)\b[\s\S]{0,40}\b(?:dataset|subset)\b/i.test(message)) return 'build';

  // A "where <column> <op> <value>" filter clause is a strong build signal.
  if (/\bwhere\b\s+[\w.]+\s*(?:=|!=|>=|<=|>|<|equals|contains)\s*\S/i.test(message)) return 'build';

  // "with <column> <op> <value>"
  if (/\bwith\b\s+[\w.\s]+\s*(?:=|!=|>=|<=|>|<|equals|contains)\s*\S/i.test(message)) return 'build';
  // "with <column> <value>" (implied = operator)
  if (/\bwith\s+[\w]+(?:\s+[\w]+)?\s+\d+\b/i.test(message)) return 'build';

  // "give/show/find/get/list/fetch + the/me/all/missing/existing" — data retrieval verbs
  if (/\b(?:give|show|find|get|list|fetch|display|return|extract|pull)\b[\s\S]{0,60}\b(?:rows?|records?|entries|ids?|values?|data|missing|existing|all)\b/i.test(message)) return 'build';

  // "missing value rows", "missing values rows", "rows with missing", "existing rows"
  if (/\b(?:missing[\s_]?values?\s+(?:rows?|records?|entries)|rows?\s+with\s+missing|existing\s+rows?)\b/i.test(message)) return 'build';

  // Default: treat anything ambiguous as a question.
  return 'question';
}

// A spec is "empty/unparseable" when the interpreter could not extract any
// projection, condition, or limit. Used to fall back from a build intent to a
// guiding text answer instead of rendering a broken empty subset card.
function isEmptySubsetSpec(spec: SubsetSpec): boolean {
  const hasCols = Array.isArray(spec.includeColumns) && spec.includeColumns.length > 0;
  const hasConds = Array.isArray(spec.conditions) && spec.conditions.length > 0;
  const hasLimit = typeof spec.limit === 'number' && spec.limit > 0;
  const hasRows = Array.isArray(spec.rowNumbers) && spec.rowNumbers.length > 0;
  return !hasCols && !hasConds && !hasLimit && !hasRows;
}

export function parseCsv(text: string): Record<string, any>[] {
  const lines: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && text[i + 1] === '\n') {
        i++;
      }
      if (current.trim().length > 0) {
        lines.push(current);
      }
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim().length > 0) {
    lines.push(current);
  }

  if (lines.length < 2) return [];

  // Parse header
  const parseLine = (line: string): string[] => {
    const values: string[] = [];
    let val = '';
    let inside = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (inside && line[i + 1] === '"') {
          val += '"';
          i++;
        } else {
          inside = !inside;
        }
      } else if (c === ',' && !inside) {
        values.push(val.trim());
        val = '';
      } else {
        val += c;
      }
    }
    values.push(val.trim());
    return values;
  };

  const headers = parseLine(lines[0]);
  const rows: Record<string, any>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const rawCols = parseLine(lines[i]);
    const rowObj: Record<string, any> = {};
    headers.forEach((h, idx) => {
      let rawVal: any = rawCols[idx] !== undefined ? rawCols[idx] : '';
      // Attempt numeric parsing if pure number
      if (rawVal !== '' && !isNaN(Number(rawVal)) && isFinite(Number(rawVal))) {
        rawVal = Number(rawVal);
      }
      rowObj[h] = rawVal;
    });
    rows.push(rowObj);
  }

  return rows;
}

export function convertJsonToCsv(data: Record<string, any>[]): string {
  if (!data || data.length === 0) return '';
  const headers = Object.keys(data[0]);
  const rows = data.map(row =>
    headers
      .map(h => {
        const val = row[h];
        if (val === null || val === undefined) return '';
        const str = String(val);
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      })
      .join(',')
  );
  return [headers.join(','), ...rows].join('\n');
}

async function startServer() {
  const app = express();
  const PORT = process.env.PORT || 3000;

  app.use(express.json({ limit: '350mb' }));
  app.use(express.urlencoded({ extended: true, limit: '350mb' }));

  // API Status & GenAI Health Check
  app.get('/api/status', async (req: Request, res: Response) => {
    res.json({
      status: 'operational',
      genAiConnected: isGeminiAvailable(),
      configuredGeminiKeys: getGeminiKeyCount(),
      model: isGeminiAvailable() ? (process.env.GEMINI_MODEL || 'gemini-2.5-flash') : 'Expert Heuristic Rule Engine (Predefined Demo Mode)',
      storage: persistentStorage.provider(),
      databaseConnected: await persistentStorage.health(),
      fileStorage: fileStorageStatus(),
      activeAnalyses: await persistentStorage.count()
    });
  });

  // AI Reliability Test Suite — runs deterministic pure-function tests
  app.get('/api/test/ai-reliability', async (_req: Request, res: Response) => {
    try {
      const { runTests } = await import('./src/tests/aiReliability.test.js');
      const results = (runTests as () => any)();
      res.json(results);
    } catch (err: any) {
      console.error('Test suite failed to load or run:', err);
      res.status(500).json({ error: err?.message || 'Test run failed.' });
    }
  });

  // Datamate Test Suite — runs deterministic analytics engine tests
  app.get('/api/test/datamate', async (_req: Request, res: Response) => {
    try {
      const { runTests } = await import('./src/tests/datamate.test.js');
      const results = (runTests as () => any)();
      res.json(results);
    } catch (err: any) {
      console.error('Datamate test suite failed to load or run:', err);
      res.status(500).json({ error: err?.message || 'Test run failed.' });
    }
  });

  // Upload Dataset (CSV or Base64 XLSX)
  app.post('/api/upload', async (req: Request, res: Response) => {
    try {
      const { fileName, fileContent, fileType, settings, datasetName, description } = req.body;

      if (!fileContent || !fileName) {
        return res.status(400).json({ error: 'No file content or filename provided.' });
      }

      // Restrict uploaded dataset to 300 MB (300 * 1024 * 1024 bytes)
      const MAX_FILE_SIZE_BYTES = 300 * 1024 * 1024;
      if (typeof fileContent === 'string' && fileContent.length > MAX_FILE_SIZE_BYTES * 1.38) {
        return res.status(413).json({ 
          error: 'Uploaded dataset exceeds the maximum allowed size of 300 MB. Please upload a file under 300 MB.' 
        });
      }

      let rows: Record<string, any>[] = [];
      let originalBuffer: Buffer;
      let originalMime = 'text/csv';

      if (fileType === 'xlsx' || fileName.endsWith('.xlsx') || fileName.endsWith('.xls')) {
        const buffer = Buffer.from(fileContent, 'base64');
        originalBuffer = buffer;
        originalMime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        if (buffer.length > MAX_FILE_SIZE_BYTES) {
          return res.status(413).json({ 
            error: 'Uploaded dataset exceeds the maximum allowed size of 300 MB. Please upload a file under 300 MB.' 
          });
        }
        const workbook = XLSX.read(buffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        if (!sheetName) {
          return res.status(400).json({ error: 'Excel workbook contains no readable sheets.' });
        }
        rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);
      } else {
        // Standard CSV text
        if (Buffer.byteLength(fileContent, 'utf8') > MAX_FILE_SIZE_BYTES) {
          return res.status(413).json({ 
            error: 'Uploaded dataset exceeds the maximum allowed size of 300 MB. Please upload a file under 300 MB.' 
          });
        }
        originalBuffer = Buffer.from(fileContent, 'utf8');
        rows = parseCsv(fileContent);
      }

      if (!rows || rows.length === 0) {
        return res.status(400).json({ error: 'Uploaded file is empty or could not be parsed into tabular rows.' });
      }

      const jobId = `JOB-${Date.now()}`;
      const cloudFile = await storeUploadedDataset(jobId, fileName, originalBuffer!, originalMime);
      const columns = profileDataset(rows);

      const analysisSettings: AnalysisSettings = settings || {
        detectDuplicates: true,
        detectInconsistentCategories: true,
        detectOutliers: true,
        useBusinessRules: true,
        generateGenAI: true,
        outlierSensitivity: 'standard'
      };

      const issues = detectQualityIssues(jobId, rows, columns, analysisSettings, [], []);
      const scoreBefore = calculateQualityScore(rows.length, columns, issues, DEFAULT_WEIGHTS);
      const corrections = generateCorrectionsFromIssues(issues, rows);

      const summary: DatasetSummary = {
        id: jobId,
        name: datasetName || fileName.replace(/\.[^/.]+$/, ''),
        description: description || `Uploaded file ${fileName} (${rows.length} rows, ${columns.length} columns)`,
        fileName,
        fileSize: fileContent.length,
        fileType: fileType === 'xlsx' ? 'xlsx' : 'csv',
        uploadedAt: new Date().toISOString(),
        rowCount: rows.length,
        columnCount: columns.length,
        status: 'awaiting_review',
        storageProvider: cloudFile.provider,
        storageObjectKey: cloudFile.objectKey || undefined
      };

      const initialErrorsSummary = buildInitialErrorsSummary(issues);
      const errorsByCategory: Record<string, number> = {};
      for (const s of initialErrorsSummary) {
        errorsByCategory[s.category] = s.count;
      }

      // Initialize git-style history track starting strictly from this dataset upload
      const analysis: AnalysisResult = {
        jobId,
        summary,
        columns,
        rawRows: rows,
        issues,
        corrections,
        scoreBefore,
        appliedCorrectionsCount: 0,
        historyLog: [
          {
            hash: generateCommitHash(),
            timestamp: new Date().toISOString(),
            action: `Initial Commit: Ingested "${summary.name}"`,
            author: 'DataAId Engine',
            details: `Dataset uploaded with ${rows.length.toLocaleString()} rows and ${columns.length} columns. Quality scan identified ${issues.length} errors across ${columns.filter(c => c.issuesCount > 0).length} columns. Initial baseline quality score: ${scoreBefore.overall}%.`,
            type: 'upload',
            stats: {
              totalErrors: issues.length,
              errorsByCategory,
              appliedCount: 0,
              scoreBefore: scoreBefore.overall,
              scoreAfter: scoreBefore.overall,
              rowsAffected: rows.length
            },
            initialErrorsSummary
          }
        ],
        settings: analysisSettings
      };

      await persistentStorage.set(jobId, analysis);
      res.json(analysis);
    } catch (err: any) {
      console.error('Error during dataset upload:', err);
      res.status(500).json({ error: err.message || 'Failed to process uploaded file.' });
    }
  });

  // Re-Analyze Dataset with updated settings or custom business rules
  app.post('/api/analyze', async (req: Request, res: Response) => {
    try {
      const { jobId, settings, customRules, customWeights } = req.body;
      const analysis = await persistentStorage.get(jobId);
      if (!analysis) {
        return res.status(404).json({ error: 'Analysis job not found.' });
      }

      const activeSettings: AnalysisSettings = settings || analysis.settings;
      const weights: QualityWeights = customWeights || analysis.scoreBefore.weights;

      // Always scan every row and every supported column. Do not suppress issues
      // merely because a previous correction was approved/rejected; the current
      // dataset contents are the source of truth for a rescan.
      const columns = profileDataset(analysis.rawRows);
      const scannedIssues = detectQualityIssues(
        jobId,
        analysis.rawRows,
        columns,
        activeSettings,
        customRules || [],
        []
      );
      const scoreBefore = calculateQualityScore(analysis.rawRows.length, columns, scannedIssues, weights);
      const newCorrections = generateCorrectionsFromIssues(scannedIssues, analysis.rawRows);

      // Rebuild correction suggestions from scratch. A rescan is a fresh audit:
      // any issue still present in the data returns as pending, even if it was
      // previously approved or rejected. Fixed cells are naturally not re-flagged.
      analysis.columns = columns;
      analysis.issues = scannedIssues;
      analysis.corrections = newCorrections;
      analysis.scoreBefore = scoreBefore;
      analysis.settings = activeSettings;
      analysis.historyLog.push({
        hash: generateCommitHash(),
        timestamp: new Date().toISOString(),
        action: scannedIssues.length === 0
          ? 'Rescan Complete — Dataset is Clean!'
          : `Rescan Complete — ${scannedIssues.length} issue${scannedIssues.length !== 1 ? 's' : ''} found`,
        author: 'DataAId Engine',
        details: `Full dataset re-scanned across ${analysis.rawRows.length} rows and ${columns.length} columns. Detected ${scannedIssues.length} current issue groups.`,
        type: 'detection'
      });

      await persistentStorage.set(jobId, analysis);
      res.json(analysis);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to re-analyze dataset.' });
    }
  });

  // Get Results by Job ID
  app.get('/api/results/:job_id', async (req: Request, res: Response) => {
    const analysis = await persistentStorage.get(req.params.job_id);
    if (!analysis) {
      return res.status(404).json({ error: 'Analysis job not found.' });
    }
    res.json(analysis);
  });

  // Get Issues by Job ID
  app.get('/api/issues/:job_id', async (req: Request, res: Response) => {
    const analysis = await persistentStorage.get(req.params.job_id);
    if (!analysis) {
      return res.status(404).json({ error: 'Analysis job not found.' });
    }
    res.json(analysis.issues);
  });

  // Generate a plain-language AI understanding of the uploaded dataset
  app.post('/api/ai/understand-dataset', async (req: Request, res: Response) => {
    try {
      const { jobId } = req.body;
      const analysis = await persistentStorage.get(jobId);
      if (!analysis) {
        return res.status(404).json({ error: 'Analysis job not found.' });
      }

      // Serve a cached understanding when one exists so revisiting the report does
      // not consume AI usage. A new upload creates a fresh AnalysisResult without
      // this field, so the cache resets naturally.
      if (analysis.datasetUnderstanding && analysis.datasetUnderstanding.trim() !== '') {
        try {
          const cached = JSON.parse(analysis.datasetUnderstanding);
          if (cached && cached.understanding) {
            const cachedProvider = (cached.provider || 'Cached') + ' (cached)';
            return res.json({ understanding: cached.understanding, provider: cachedProvider });
          }
        } catch {
          // Corrupt cache envelope — fall through to regeneration.
        }
      }

      const understanding = await understandDatasetWithAI({
        datasetName: analysis.summary.name,
        rowCount: analysis.summary.rowCount,
        columnCount: analysis.summary.columnCount,
        columns: analysis.columns.map(column => ({
          name: column.name,
          dataType: column.dataType,
          missingCount: column.missingCount,
          uniqueCount: column.uniqueCount,
          sampleValues: (column.sampleValues || []).slice(0, 8),
          frequentValues: (column.frequentValues || []).slice(0, 5),
          min: column.min,
          max: column.max,
          mean: column.mean
        }))
      });
      const provider = isGeminiAvailable() ? 'Gemini' : 'Profile-based fallback';
      // Persist the generated understanding as a JSON envelope so cache hits can
      // restore the original provider label and the response shape stays unchanged.
      analysis.datasetUnderstanding = JSON.stringify({ understanding, provider });
      await persistentStorage.set(jobId, analysis);
      res.json({ understanding, provider });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to understand dataset.' });
    }
  });

  // Ask questions about the active dataset using bounded profile context, not the full raw file.
  app.post('/api/ai/chat', async (req: Request, res: Response) => {
    try {
      const { jobId, question } = req.body;
      if (typeof question !== 'string' || !question.trim() || question.length > 1200) {
        return res.status(400).json({ error: 'Enter a question up to 1,200 characters.' });
      }
      const analysis = await persistentStorage.get(jobId);
      if (!analysis) return res.status(404).json({ error: 'Analysis job not found.' });

      const structured = await chatWithDatasetAI({ analysis, question: question.trim() });

      // Append the Q&A pair to the persisted chat history so the full conversation
      // survives page switches and browser reloads. Server is the source of truth.
      analysis.chatHistory = analysis.chatHistory || [];
      analysis.chatHistory.push({ role: 'user', content: question.trim() });
      analysis.chatHistory.push({ role: 'assistant', content: structured.answer, provider: structured.provider, structured });
      await persistentStorage.set(jobId, analysis);
      res.json({ answer: structured.answer, provider: structured.provider, structured, chatHistory: analysis.chatHistory });
    } catch (error: any) {
      console.error('Dataset AI chat failed:', error);
      res.status(500).json({ error: error.message || 'Could not answer this dataset question.' });
    }
  });

  // Lightweight endpoint to load persisted Datamate chat history without shipping
  // the full AnalysisResult (which may include a large rawRows payload).
  app.get('/api/ai/chat-history/:job_id', async (req: Request, res: Response) => {
    const analysis = await persistentStorage.get(req.params.job_id);
    if (!analysis) {
      return res.status(404).json({ error: 'Analysis job not found.' });
    }
    res.json({ chatHistory: analysis.chatHistory || [] });
  });

  // Build a custom subset of the active dataset from a natural-language
  // instruction. The AI only produces a validated SubsetSpec (column names/types
  // are sent, never the raw rows); the server applies it deterministically to
  // analysis.rawRows, persists the spec for re-download, and appends the build
  // to the persisted conversation. Server is the source of truth for chat history.
  app.post('/api/ai/build-subset', async (req: Request, res: Response) => {
    try {
      const { jobId, instruction } = req.body;
      if (typeof instruction !== 'string' || !instruction.trim() || instruction.trim().length > 2000) {
        return res.status(400).json({ error: 'Enter a dataset instruction up to 2,000 characters.' });
      }
      const analysis = await persistentStorage.get(jobId);
      if (!analysis) {
        return res.status(404).json({ error: 'Analysis job not found.' });
      }

      const cleanInstruction = instruction.trim();
      const { spec, provider, warnings } = await interpretSubsetInstruction(cleanInstruction, analysis.columns);
      const invalidRows = (spec.rowNumbers || []).filter(rowNumber => rowNumber > analysis.rawRows.length);
      if (invalidRows.length) warnings.push(`Requested row number(s) ${invalidRows.join(', ')} exceed the dataset's ${analysis.rawRows.length} data rows.`);
      const { rows, columns }: AppliedSubset = applySubsetSpec(analysis.rawRows, spec, analysis.columns);
      if (rows.length === 0 && invalidRows.length === 0) warnings.push('No dataset rows matched the requested row numbers and filter conditions.');

      const subsetId = 'SUBSET-' + Date.now() + '-' + Math.random().toString(16).slice(2, 7);
      const previewRows = rows.slice(0, 100);
      const subset: SubsetResult = {
        subsetId,
        instruction: cleanInstruction,
        spec,
        columns,
        rowCount: rows.length,
        previewRows,
        provider,
        warnings
      };

      // Persist the spec (not the full rows) so the subset can be re-downloaded.
      analysis.subsets = analysis.subsets || [];
      analysis.subsets.push({
        subsetId,
        instruction: cleanInstruction,
        spec,
        columns,
        rowCount: rows.length,
        previewRows,
        provider,
        warnings
      });

      // Append the build to the persisted conversation (server is source of truth).
      analysis.chatHistory = analysis.chatHistory || [];
      analysis.chatHistory.push({ role: 'user', content: cleanInstruction });
      analysis.chatHistory.push({
        role: 'assistant',
        content: `Built a subset of ${rows.length} row${rows.length === 1 ? '' : 's'} across ${columns.length} column${columns.length === 1 ? '' : 's'}.`,
        subset
      });

      await persistentStorage.set(jobId, analysis);
      res.json({ chatHistory: analysis.chatHistory, subset });
    } catch (err: any) {
      console.error('Build subset failed:', err);
      res.status(500).json({ error: err.message || 'Could not build the dataset subset.' });
    }
  });

  // Unified Datamate endpoint. The client sends a single free-text message and
  // the server decides — via the heuristic classifyDatamateIntent classifier —
  // whether the user wants a dataset subset built (returns a preview + download)
  // or a plain question answered (returns text). Replaces the client-side
  // Ask AI / Build Dataset toggle so the chat "gives what they ask" with no mode
  // selection. Classification, Q&A, and subset building all work without a
  // GEMINI_API_KEY (heuristic/demo paths); only column names/types ever reach
  // Gemini, never raw rows. The existing /api/ai/chat and /api/ai/build-subset
  // endpoints remain untouched; only the Datamate UI now uses this one.
  app.post('/api/ai/datamate', async (req: Request, res: Response) => {
    try {
      const { jobId, message, mode } = req.body;
      if (typeof message !== 'string' || !message.trim() || message.trim().length > 2000) {
        return res.status(400).json({ error: 'Enter a message up to 2,000 characters.' });
      }
      const analysis = await persistentStorage.get(jobId);
      if (!analysis) {
        return res.status(404).json({ error: 'Analysis job not found.' });
      }

      const cleanMessage = message.trim();
      analysis.chatHistory = analysis.chatHistory || [];

      // Datamate is a dataset Q&A assistant in this UI. The old mode toggle
      // has been removed; never turn a normal question into an unintended export.
      const resolvedMode: string = 'question';

      if (resolvedMode === 'build') {
        // BUILD path: reuse the existing interpreter + deterministic applySubsetSpec.
        // Only column names/types are sent to Gemini (inside interpretSubsetInstruction),
        // never the raw rows.
        const { spec, provider, warnings } = await interpretSubsetInstruction(cleanMessage, analysis.columns);
        const invalidRows = (spec.rowNumbers || []).filter(rowNumber => rowNumber > analysis.rawRows.length);
        if (invalidRows.length) warnings.push(`Requested row number(s) ${invalidRows.join(', ')} exceed the dataset's ${analysis.rawRows.length} data rows.`);

        // Edge case: build intent but nothing usable was parsed. Do NOT return a
        // broken empty subset card; guide the user with a text answer instead.
        if (isEmptySubsetSpec(spec)) {
          const answer = 'I couldn\'t build a dataset from that. Try phrasing it like \u201crows where country = US\u201d or \u201ccolumns name, email where revenue > 1000\u201d.';
          analysis.chatHistory.push({ role: 'user', content: cleanMessage });
          analysis.chatHistory.push({ role: 'assistant', content: answer });
          await persistentStorage.set(jobId, analysis);
          return res.json({
            type: 'answer',
            answer,
            provider: isGeminiAvailable() ? 'Gemini' : 'Profile-based fallback',
            chatHistory: analysis.chatHistory
          });
        }

        const { rows, columns }: AppliedSubset = applySubsetSpec(analysis.rawRows, spec, analysis.columns);
        if (rows.length === 0 && invalidRows.length === 0) {
          // Check if this was a missing-value filter — give a specific helpful message
          const isMissingFilter = Array.isArray(spec.conditions) && spec.conditions.some(c => c.operator === 'isNull');
          if (isMissingFilter) {
            const targetCols = spec.conditions!.filter(c => c.operator === 'isNull').map(c => c.column);
            const colLabel = targetCols.length === 1 ? `"${targetCols[0]}"` : 'the selected columns';
            warnings.push(`No rows have missing values in ${colLabel}. The column appears to be fully populated.`);
          } else {
            warnings.push('No dataset rows matched the requested row numbers and filter conditions.');
          }
        }
        // Warn when a missing-value filter returned ALL rows (column fully populated but filter applied to all cols)
        if (rows.length === analysis.rawRows.length && Array.isArray(spec.conditions) && spec.conditions.length > 0 && spec.conditionLogic === 'OR') {
          const isMissingFilter = spec.conditions.every(c => c.operator === 'isNull');
          if (isMissingFilter) {
            warnings.push('All rows were returned because at least one column has a missing value in each row. Use a specific column name for a focused result, e.g. "give email rows with missing value".');
          }
        }
        // If 0 rows matched a missing-value filter, return a text answer instead of an empty table
        if (rows.length === 0) {
          const isMissingFilter = Array.isArray(spec.conditions) && spec.conditions.some(c => c.operator === 'isNull');
          const targetCols = isMissingFilter
            ? spec.conditions!.filter(c => c.operator === 'isNull').map(c => c.column)
            : [];
          const answer = isMissingFilter && targetCols.length > 0
            ? `No rows have missing values in the "${targetCols[0]}" column — it appears to be fully populated across all ${analysis.rawRows.length} rows. If you're looking for invalid formats (e.g. emails without @), check the Correction Center for format issues.`
            : `No rows matched your filter. Try adjusting the condition or check the Correction Center to see detected issues.`;
          analysis.chatHistory.push({ role: 'user', content: cleanMessage });
          analysis.chatHistory.push({ role: 'assistant', content: answer });
          await persistentStorage.set(jobId, analysis);
          return res.json({ type: 'answer', answer, provider, chatHistory: analysis.chatHistory });
        }

        const subsetId = 'SUBSET-' + Date.now() + '-' + Math.random().toString(16).slice(2, 7);
        const previewRows = rows.slice(0, 100);
        const subset: SubsetResult = {
          subsetId,
          instruction: cleanMessage,
          spec,
          columns,
          rowCount: rows.length,
          previewRows,
          provider,
          warnings
        };

        // Persist the preview-relevant fields on the StoredSubset so the subset
        // card can re-render from history after a page switch / browser reload
        // with no extra fetch (the download endpoint still re-applies the spec).
        analysis.subsets = analysis.subsets || [];
        analysis.subsets.push({
          subsetId,
          instruction: cleanMessage,
          spec,
          columns,
          rowCount: rows.length,
          previewRows,
          provider,
          warnings
        });

        analysis.chatHistory.push({ role: 'user', content: cleanMessage });
        analysis.chatHistory.push({
          role: 'assistant',
          content: `Built a subset of ${rows.length} row${rows.length === 1 ? '' : 's'} across ${columns.length} column${columns.length === 1 ? '' : 's'}.`,
          subset
        });

        await persistentStorage.set(jobId, analysis);
        return res.json({ type: 'subset', subset, chatHistory: analysis.chatHistory });
      }

      // Deterministic dataset facts are answered directly from rawRows. These
      // common questions must never depend on Gemini availability or quotas.
      const directAnswer = buildDirectDatasetAnswer(analysis, cleanMessage);
      if (directAnswer) {
        analysis.chatHistory.push({ role: 'user', content: cleanMessage });
        analysis.chatHistory.push({ role: 'assistant', content: directAnswer.answer, provider: 'Dataset analysis', structured: directAnswer });
        await persistentStorage.set(jobId, analysis);
        return res.json({ type: 'answer', answer: directAnswer.answer, provider: 'Dataset analysis', structured: directAnswer, chatHistory: analysis.chatHistory });
      }

      // QUESTION path: use Gemini for explanatory questions after deterministic
      // dataset facts have been handled locally. Pass recent history for context.
      const recentHistory = (analysis.chatHistory || [])
        .slice(-6)
        .map(m => ({ role: m.role, content: m.content }));

      // Compute exact analytics before sending to Gemini
      const intent = parseQuestionIntent(cleanMessage, analysis.columns.map(c => c.name));
      const computedFacts = computeDatasetAnalytics(analysis, intent);

      const structured = await chatWithDatasetAI({
        analysis,
        question: cleanMessage,
        recentHistory,
        computedFacts: computedFacts.length > 0 ? computedFacts : undefined
      });
      const answerProvider = structured.provider || (isGeminiAvailable() ? 'Gemini' : 'Profile-based fallback');
      analysis.chatHistory.push({ role: 'user', content: cleanMessage });
      analysis.chatHistory.push({
        role: 'assistant',
        content: structured.answer,
        provider: answerProvider,
        structured,
        computedFacts: computedFacts.length > 0
          ? { label: computedFacts[0].label, result: computedFacts[0].value, type: intent.type }
          : undefined
      });
      await persistentStorage.set(jobId, analysis);
      return res.json({ type: 'answer', answer: structured.answer, provider: answerProvider, structured, chatHistory: analysis.chatHistory });
    } catch (error: any) {
      console.error('Datamate unified endpoint failed:', error);
      res.status(500).json({ error: error.message || 'Could not process this Datamate message.' });
    }
  });

  // GenAI Explain Single Issue
  app.post('/api/ai/explain', async (req: Request, res: Response) => {
    try {
      const { jobId, issueId } = req.body;
      const analysis = await persistentStorage.get(jobId);
      if (!analysis) {
        return res.status(404).json({ error: 'Analysis job not found.' });
      }

      const issue = analysis.issues.find(i => i.id === issueId);
      if (!issue) {
        return res.status(404).json({ error: 'Issue not found in dataset analysis.' });
      }

      const colInfo = analysis.columns.find(c => c.name === issue.column);
      const explanation = await explainQualityIssueWithAI(issue, colInfo ? {
        dataType: colInfo.dataType,
        sampleValues: colInfo.sampleValues
      } : undefined);

      issue.aiExplanation = explanation;
      if (explanation.proposedCorrection && issue.category !== 'invalid_format' && issue.category !== 'missing_value') {
        issue.proposedValue = explanation.proposedCorrection;
        // Also update matching corrections
        for (const cor of analysis.corrections) {
          if (cor.issueId === issue.id && cor.status === 'pending') {
            cor.proposedValue = explanation.proposedCorrection;
            cor.source = 'genai';
          }
        }
      }

      await persistentStorage.set(jobId, analysis);

      // Validate the proposed correction
      let correctionValidation = null;
      try {
        const propVal = explanation.proposedCorrection ?? String(issue.proposedValue ?? '');
        correctionValidation = validateCorrection({
          proposedValue: propVal,
          column: colInfo,
          rawRows: analysis.rawRows,
          issue
        });
      } catch (valErr) {
        console.warn('validateCorrection failed:', valErr);
      }

      res.json({ issue, explanation, correctionValidation });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to generate AI explanation.' });
    }
  });

  // GenAI Explain All Issues in Job
  app.post('/api/ai/explain-all', async (req: Request, res: Response) => {
    try {
      const { jobId } = req.body;
      const analysis = await persistentStorage.get(jobId);
      if (!analysis) {
        return res.status(404).json({ error: 'Analysis job not found.' });
      }

      for (const issue of analysis.issues) {
        if (!issue.aiExplanation) {
          const colInfo = analysis.columns.find(c => c.name === issue.column);
          const explanation = await explainQualityIssueWithAI(issue, colInfo ? {
            dataType: colInfo.dataType,
            sampleValues: colInfo.sampleValues
          } : undefined);
          issue.aiExplanation = explanation;
          if (explanation.proposedCorrection && issue.category !== 'invalid_format' && issue.category !== 'missing_value') {
            issue.proposedValue = explanation.proposedCorrection;
            for (const cor of analysis.corrections) {
              if (cor.issueId === issue.id && cor.status === 'pending') {
                cor.proposedValue = explanation.proposedCorrection;
                cor.source = 'genai';
              }
            }
          }
        }
      }

      await persistentStorage.set(jobId, analysis);

      // Build correctionValidations map keyed by issue.id
      const correctionValidations: Record<string, any> = {};
      for (const issue of analysis.issues) {
        try {
          const col = analysis.columns.find(c => c.name === issue.column);
          const propVal = issue.aiExplanation?.proposedCorrection ?? String(issue.proposedValue ?? '');
          correctionValidations[issue.id] = validateCorrection({
            proposedValue: propVal,
            column: col,
            rawRows: analysis.rawRows,
            issue
          });
        } catch {
          // Skip validation for this issue on error
        }
      }

      res.json({ success: true, issues: analysis.issues, correctionValidations });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to explain all issues.' });
    }
  });

  // AI-powered alternate suggestions for text missing values
  app.post('/api/ai/suggest-alternates', async (req: Request, res: Response) => {
    try {
      const { columnName, sampleValues, rowContext } = req.body;
      const alternates = await generateMissingValueAlternatesAI(
        String(columnName || 'field'),
        Array.isArray(sampleValues) ? sampleValues : [],
        rowContext || {}
      );
      res.json({ alternates });
    } catch (err: any) {
      console.warn('Failed to generate AI alternates:', err);
      res.status(500).json({ error: err.message || 'Failed to generate alternates' });
    }
  });

  // Preview Corrections Diff
  app.post('/api/corrections/preview', async (req: Request, res: Response) => {
    const { jobId } = req.body;
    const analysis = await persistentStorage.get(jobId);
    if (!analysis) {
      return res.status(404).json({ error: 'Analysis job not found.' });
    }

    const preview = previewCorrectionsDiff(analysis.rawRows, analysis.corrections);
    res.json(preview);
  });

  // Update Correction Items (Approve, Reject, or Edit proposed value)
  app.post('/api/corrections/update', async (req: Request, res: Response) => {
    const { jobId, correctionId, status, editedValue, bulkAction, columnName, correctedRows } = req.body;
    const analysis = await persistentStorage.get(jobId);
    if (!analysis) {
      return res.status(404).json({ error: 'Analysis job not found.' });
    }

    if (bulkAction === 'approve_all') {
      let count = 0;
      analysis.corrections.forEach(c => {
        if (c.status === 'pending') {
          c.status = 'approved';
          count++;
        }
      });
      // Mark all date-like columns whose issues are now fully approved as knownGood
      if (!analysis.knownGoodColumns) analysis.knownGoodColumns = [];
      analysis.issues
        .filter(iss => iss.category === 'invalid_format' && !/^time$/i.test(iss.column.trim()) && /date|created|updated|dob|time/i.test(iss.column))
        .forEach(iss => {
          if (!analysis.knownGoodColumns!.includes(iss.column)) analysis.knownGoodColumns!.push(iss.column);
        });
      analysis.historyLog.push({
        hash: generateCommitHash(),
        timestamp: new Date().toISOString(),
        action: `Approved All Corrections (${count} items)`,
        author: 'User (Action)',
        details: `Approved all ${count} pending data transformations across the dataset.`,
        type: 'approval',
        stats: { appliedCount: count }
      });
    } else if (bulkAction === 'reject_all') {
      let count = 0;
      analysis.corrections.forEach(c => {
        if (c.status === 'pending') {
          c.status = 'rejected';
          count++;
        }
      });
      // Mark all issues as rejected so they don't show as active issues
      analysis.issues.forEach(iss => {
        const relCors = analysis.corrections.filter(c => c.issueId === iss.id);
        if (relCors.length === 0 || relCors.every(c => c.status === 'rejected')) {
          iss.resolutionStatus = 'rejected';
        }
      });
      // Also add date columns to knownGood so reject doesn't re-trigger
      if (!analysis.knownGoodColumns) analysis.knownGoodColumns = [];
      analysis.issues
        .filter(iss => iss.category === 'invalid_format' && !/^time$/i.test(iss.column.trim()) && /date|created|updated|dob|time/i.test(iss.column))
        .forEach(iss => {
          if (!analysis.knownGoodColumns!.includes(iss.column)) analysis.knownGoodColumns!.push(iss.column);
        });
      analysis.historyLog.push({
        hash: generateCommitHash(),
        timestamp: new Date().toISOString(),
        action: `Rejected All Corrections (${count} items)`,
        author: 'User (Action)',
        details: `Rejected all ${count} pending corrections, retaining original cell values.`,
        type: 'rejection'
      });
    } else if (bulkAction === 'restore_snapshot' && req.body.snapshot && !Array.isArray(req.body.snapshot)) {
      // Restore the full analysis state. This revives deleted rows and the
      // matching issues/corrections, even when their IDs were regenerated.
      const snapshot = req.body.snapshot;
      if (Array.isArray(snapshot.rawRows)) analysis.rawRows = JSON.parse(JSON.stringify(snapshot.rawRows));
      if (Array.isArray(snapshot.cleanedRows)) analysis.cleanedRows = JSON.parse(JSON.stringify(snapshot.cleanedRows));
      if (Array.isArray(snapshot.corrections)) analysis.corrections = JSON.parse(JSON.stringify(snapshot.corrections));
      if (Array.isArray(snapshot.issues)) analysis.issues = JSON.parse(JSON.stringify(snapshot.issues));
      if (Array.isArray(snapshot.columns)) analysis.columns = JSON.parse(JSON.stringify(snapshot.columns));
      if (snapshot.summary) analysis.summary = JSON.parse(JSON.stringify(snapshot.summary));
      analysis.summary.rowCount = analysis.rawRows.length;
      analysis.columns = profileDataset(analysis.rawRows);
      analysis.scoreBefore = calculateQualityScore(
        analysis.rawRows.length,
        analysis.columns,
        analysis.issues,
        analysis.scoreBefore.weights
      );
    } else if (bulkAction === 'approve_safe') {
      let count = 0;
      analysis.corrections.forEach(c => {
        const issue = analysis.issues.find(i => i.id === c.issueId);
        if (c.status === 'pending' && issue && issue.severity !== 'critical') {
          c.status = 'approved';
          count++;
        }
      });
      analysis.historyLog.push({
        hash: generateCommitHash(),
        timestamp: new Date().toISOString(),
        action: `Approved Safe Corrections (${count} items)`,
        author: 'User (Action)',
        details: `Automatically approved ${count} low and medium risk transformations.`,
        type: 'approval',
        stats: { appliedCount: count }
      });
    } else if (bulkAction === 'approve_column' && columnName) {
      let count = 0;
      analysis.corrections.forEach(c => {
        if (c.column === columnName && c.status === 'pending') { c.status = 'approved'; count++; }
      });
      analysis.historyLog.push({ hash: generateCommitHash(), timestamp: new Date().toISOString(), action: `Approved All in Column "${columnName}" (${count})`, author: 'User (Action)', details: `Approved ${count} pending corrections in column "${columnName}".`, type: 'approval', stats: { appliedCount: count } });
    } else if (bulkAction === 'reject_column' && columnName) {
      let count = 0;
      analysis.corrections.forEach(c => {
        if (c.column === columnName && c.status === 'pending') { c.status = 'rejected'; count++; }
      });
      analysis.historyLog.push({ hash: generateCommitHash(), timestamp: new Date().toISOString(), action: `Rejected All in Column "${columnName}" (${count})`, author: 'User (Action)', details: `Rejected ${count} pending corrections in column "${columnName}".`, type: 'rejection' });
    } else if (bulkAction === 'reexamine_dates' && columnName && Array.isArray(correctedRows)) {
      const dateFormat: string = req.body.dateFormat || 'YYYYMMDD';
      const dateSeparator: string = req.body.dateSeparator ?? '-';

      // Apply corrected date values to rawRows for all provided rows
      (correctedRows as { rowRef: number; value: string }[]).forEach(cr => {
        const rowIdx = cr.rowRef - 1;
        if (analysis.rawRows[rowIdx]) {
          analysis.rawRows[rowIdx][columnName] = cr.value;
        }
        const cor = analysis.corrections.find(c => c.column === columnName && c.rowRef === cr.rowRef);
        if (cor) {
          cor.proposedValue = cr.value;
          cor.editedValue = cr.value;
          cor.status = 'applied';
          cor.reason = `Date corrected to match column format (${dateFormat} with "${dateSeparator}" separator).`;
        }
      });

      // Re-run full quality detection on updated rawRows so column status refreshes
      const reProfiledColumns = profileDataset(analysis.rawRows);
      // Add this column to knownGoodColumns so it won't be re-flagged as invalid
      if (!analysis.knownGoodColumns) analysis.knownGoodColumns = [];
      if (!analysis.knownGoodColumns.includes(columnName)) {
        analysis.knownGoodColumns.push(columnName);
      }

      const reDetectedIssues = detectQualityIssues(
        analysis.jobId,
        analysis.rawRows,
        reProfiledColumns,
        analysis.settings || {
          detectDuplicates: true,
          detectInconsistentCategories: true,
          detectOutliers: true,
          useBusinessRules: true,
          generateGenAI: false,
          outlierSensitivity: 'standard'
        },
        [],
        analysis.knownGoodColumns
      );
      // Rebuild corrections for remaining issues
      const reBuiltCorrections = generateCorrectionsFromIssues(reDetectedIssues, analysis.rawRows);

      // For any remaining date issues in the same column, convert proposedValue to the user's chosen format
      const formatDate = (isoLike: string): string => {
        if (!isoLike) return isoLike;
        const parts = isoLike.split(/[-/.]/);
        if (parts.length !== 3) return isoLike;
        let y = '', m = '', d = '';
        // Detect if already ISO (YYYY-MM-DD)
        if (parts[0].length === 4) { y = parts[0]; m = parts[1]; d = parts[2]; }
        else if (parts[2].length === 4) {
          if (dateFormat.startsWith('DD')) { d = parts[0]; m = parts[1]; y = parts[2]; }
          else { m = parts[0]; d = parts[1]; y = parts[2]; }
        } else return isoLike;
        const pad = (s: string, n: number) => s.padStart(n, '0');
        switch (dateFormat) {
          case 'DDMMYYYY': return [pad(d,2), pad(m,2), pad(y,4)].join(dateSeparator);
          case 'MMDDYYYY': return [pad(m,2), pad(d,2), pad(y,4)].join(dateSeparator);
          case 'YYYYMMDD': return [pad(y,4), pad(m,2), pad(d,2)].join(dateSeparator);
          case 'YYYYDDMM': return [pad(y,4), pad(d,2), pad(m,2)].join(dateSeparator);
          case 'DDYYYYMM': return [pad(d,2), pad(y,4), pad(m,2)].join(dateSeparator);
          case 'MMYYYYDD': return [pad(m,2), pad(y,4), pad(d,2)].join(dateSeparator);
          default: return isoLike;
        }
      };

      reBuiltCorrections.forEach(cor => {
        if (cor.column === columnName && cor.proposedValue) {
          cor.proposedValue = formatDate(String(cor.proposedValue));
        }
      });

      analysis.columns = reProfiledColumns;
      analysis.issues = reDetectedIssues;
      analysis.corrections = reBuiltCorrections;
      analysis.summary.rowCount = analysis.rawRows.length;
      analysis.scoreBefore = calculateQualityScore(
        analysis.rawRows.length,
        reProfiledColumns,
        reDetectedIssues,
        analysis.scoreBefore.weights
      );

      analysis.historyLog.push({
        hash: generateCommitHash(),
        timestamp: new Date().toISOString(),
        action: `Re-examined Dates in "${columnName}" (${correctedRows.length} rows corrected)`,
        author: 'User (Date Format)',
        details: `Applied date format correction to ${correctedRows.length} rows in column "${columnName}". Dataset re-examined — ${reDetectedIssues.length} issues remain.`,
        type: 'edit'
      });
    } else if (correctionId) {
      const item = analysis.corrections.find(c => c.id === correctionId);
      if (item) {
        if (status) {
          item.status = status;
          if (status === 'approved') {
            const finalValue = editedValue !== undefined ? editedValue : item.editedValue !== undefined ? item.editedValue : item.proposedValue;
            const rowIndex = item.rowRef - 1;
            if (finalValue !== 'DROP_ROW' && analysis.rawRows[rowIndex] && item.column !== 'Entire Row' && item.column !== 'All Columns (Full Record)') {
              analysis.rawRows[rowIndex][item.column] = finalValue;
            }

            analysis.historyLog.push({
              hash: generateCommitHash(),
              timestamp: new Date().toISOString(),
              action: `Approved Correction (Row #${item.rowRef}, ${item.column})`,
              author: 'User (Review)',
              details: `Approved proposed change for row #${item.rowRef} column "${item.column}".`,
              type: 'approval'
            });
          } else if (status === 'rejected') {
            analysis.historyLog.push({
              hash: generateCommitHash(),
              timestamp: new Date().toISOString(),
              action: `Rejected Correction (Row #${item.rowRef}, ${item.column})`,
              author: 'User (Review)',
              details: `Rejected proposed change for row #${item.rowRef} column "${item.column}".`,
              type: 'rejection'
            });
          }
        }
        if (editedValue !== undefined) {
          item.editedValue = editedValue;
          analysis.historyLog.push({
            hash: generateCommitHash(),
            timestamp: new Date().toISOString(),
            action: `Custom Value Override (Row #${item.rowRef}, ${item.column})`,
            author: 'User (Edit)',
            details: `Manually set value to "${editedValue}" on row #${item.rowRef} column "${item.column}".`,
            type: 'edit'
          });
        }
      }
    }

    // Sync issue resolution status so rejected items are no longer considered issues
    analysis.issues.forEach(iss => {
      const relCorrections = analysis.corrections.filter(c => c.issueId === iss.id);
      if (relCorrections.length > 0) {
        if (relCorrections.every(c => c.status === 'rejected')) {
          iss.resolutionStatus = 'rejected';
        } else if (relCorrections.every(c => c.status === 'approved' || c.status === 'applied')) {
          iss.resolutionStatus = 'approved';
        } else if (relCorrections.some(c => c.status === 'pending')) {
          iss.resolutionStatus = 'pending';
        }
      }
    });

    // After syncing: if ALL corrections for a date/format column are approved or rejected
    // (i.e. user has dealt with every issue in that column), add it to knownGoodColumns
    // so re-detection never flags it again
    if (!analysis.knownGoodColumns) analysis.knownGoodColumns = [];
    const isPureTimeCol = (name: string) => /^time$/i.test(name.trim());
    const isDateLikeCol = (name: string) =>
      !isPureTimeCol(name) && (/date|created|updated|dob/i.test(name) || /time/i.test(name));

    // Collect all date-like columns that have invalid_format issues
    const dateIssueColumns = new Set(
      analysis.issues
        .filter(iss => iss.category === 'invalid_format' && isDateLikeCol(iss.column))
        .map(iss => iss.column)
    );

    dateIssueColumns.forEach(col => {
      const colCorrections = analysis.corrections.filter(c => c.column === col);
      const allDealt = colCorrections.length > 0 &&
        colCorrections.every(c => c.status === 'approved' || c.status === 'applied' || c.status === 'rejected');
      if (allDealt && !analysis.knownGoodColumns!.includes(col)) {
        analysis.knownGoodColumns!.push(col);
      }
    });

    // Recalculate scores so rejected items immediately improve dataset health and are not considered issues
    analysis.scoreBefore = calculateQualityScore(
      analysis.rawRows.length,
      analysis.columns,
      analysis.issues,
      analysis.scoreBefore.weights
    );
    if (analysis.scoreAfter) {
      analysis.scoreAfter = calculateQualityScore(
        (analysis.cleanedRows || analysis.rawRows).length,
        analysis.columns,
        analysis.issues,
        analysis.scoreBefore.weights
      );
    }

    await persistentStorage.set(jobId, analysis);

    // These actions replace the full analysis state in the client.
    if (bulkAction === 'reexamine_dates' || bulkAction === 'restore_snapshot') {
      return res.json(analysis);
    }

    res.json({ 
      success: true, 
      rawRows: analysis.rawRows,
      cleanedRows: analysis.cleanedRows,
      columns: analysis.columns,
      summary: analysis.summary,
      corrections: analysis.corrections, 
      issues: analysis.issues,
      scoreBefore: analysis.scoreBefore,
      scoreAfter: analysis.scoreAfter
    });
  });

  // Direct Row Deletion Endpoint (for deleting duplicate rows immediately)
  app.post('/api/rows/delete', async (req: Request, res: Response) => {
    try {
      const { jobId, rowRef } = req.body;
      const analysis = await persistentStorage.get(jobId);
      if (!analysis) {
        return res.status(404).json({ error: 'Job not found' });
      }

      const rowIndex = Number(rowRef) - 1;
      if (rowIndex >= 0 && rowIndex < analysis.rawRows.length) {
        // Remove row from rawRows and cleanedRows
        analysis.rawRows.splice(rowIndex, 1);
        if (analysis.cleanedRows && rowIndex < analysis.cleanedRows.length) {
          analysis.cleanedRows.splice(rowIndex, 1);
        }
        analysis.summary.rowCount = analysis.rawRows.length;

        // Re-profile and re-detect issues
        analysis.columns = profileDataset(analysis.rawRows);
        analysis.issues = detectQualityIssues(analysis.jobId, analysis.rawRows, analysis.columns, analysis.settings, [], analysis.knownGoodColumns || []);
        analysis.corrections = generateCorrectionsFromIssues(analysis.issues, analysis.rawRows);
        analysis.scoreBefore = calculateQualityScore(
          analysis.rawRows.length,
          analysis.columns,
          analysis.issues,
          analysis.scoreBefore.weights
        );

        analysis.historyLog.push({
          hash: generateCommitHash(),
          timestamp: new Date().toISOString(),
          action: `Deleted Duplicate Row #${rowRef}`,
          author: 'User (Action)',
          details: `Directly removed duplicate row #${rowRef}. Active dataset re-evaluated with updated row count (${analysis.rawRows.length}).`,
          type: 'apply'
        });

        await persistentStorage.set(jobId, analysis);
        return res.json(analysis);
      }
      return res.status(400).json({ error: 'Invalid row reference' });
    } catch (err: any) {
      console.error('Failed to delete row:', err);
      res.status(500).json({ error: err.message || 'Failed to delete row' });
    }
  });

  // Apply Approved Corrections
  app.post('/api/corrections/apply', async (req: Request, res: Response) => {
    try {
      const { jobId, approveAll } = req.body;
      const analysis = await persistentStorage.get(jobId);
      if (!analysis) {
        return res.status(404).json({ error: 'Analysis job not found.' });
      }

      if (approveAll) {
        analysis.corrections.forEach(c => {
          if (c.status === 'pending') c.status = 'approved';
        });
      }

      const updated = applyApprovedCorrections(analysis);

      // After applying: add any date-like columns whose corrections are all dealt with to knownGoodColumns
      if (!updated.knownGoodColumns) updated.knownGoodColumns = [];
      const isPureTime = (n: string) => /^time$/i.test(n.trim());
      const isDateLike = (n: string) => !isPureTime(n) && (/date|created|updated|dob/i.test(n) || /time/i.test(n));
      const dateInvalidCols = new Set(
        updated.issues
          .filter(iss => iss.category === 'invalid_format' && isDateLike(iss.column))
          .map(iss => iss.column)
      );
      // Also check issues that were just applied (they're no longer in issues array after apply)
      analysis.issues
        .filter(iss => iss.category === 'invalid_format' && isDateLike(iss.column) && iss.resolutionStatus === 'applied')
        .forEach(iss => dateInvalidCols.add(iss.column));

      dateInvalidCols.forEach(col => {
        if (!updated.knownGoodColumns!.includes(col)) {
          updated.knownGoodColumns!.push(col);
        }
      });

      await persistentStorage.set(jobId, updated);
      res.json(updated);
    } catch (err: any) {
      console.error('Failed to apply corrections:', err);
      res.status(500).json({ error: err.message || 'Failed to apply approved corrections.' });
    }
  });

  // Analysis History
  app.get('/api/history', async (req: Request, res: Response) => {
    res.json(await persistentStorage.listHistory());
  });

  // Detailed Report Data
  app.get('/api/report/:job_id', async (req: Request, res: Response) => {
    const analysis = await persistentStorage.get(req.params.job_id);
    if (!analysis) {
      return res.status(404).json({ error: 'Analysis job not found.' });
    }

    const issuesByCategory: Record<string, number> = {};
    const issuesBySeverity: Record<string, number> = {};

    analysis.issues.forEach(iss => {
      issuesByCategory[iss.category] = (issuesByCategory[iss.category] || 0) + 1;
      issuesBySeverity[iss.severity] = (issuesBySeverity[iss.severity] || 0) + 1;
    });

    const report = {
      summary: analysis.summary,
      scoreBefore: analysis.scoreBefore,
      scoreAfter: analysis.scoreAfter,
      issuesCount: analysis.issues.length,
      unresolvedCount: analysis.issues.filter(i => i.resolutionStatus === 'pending').length,
      appliedCount: analysis.appliedCorrectionsCount,
      issuesByCategory,
      issuesBySeverity,
      columns: analysis.columns,
      issues: analysis.issues,
      corrections: analysis.corrections,
      historyLog: analysis.historyLog,
      generatedAt: new Date().toISOString()
    };

    res.json(report);
  });

  // Download Files
  app.get('/api/download/:job_id', async (req: Request, res: Response) => {
    const { job_id } = req.params;
    const type = req.query.type as string; // 'cleaned_csv' | 'cleaned_xlsx' | 'issues_csv' | 'corrections_csv'
    const analysis = await persistentStorage.get(job_id);

    if (!analysis) {
      return res.status(404).send('Analysis not found.');
    }

    if (type === 'cleaned_csv') {
      const rows = analysis.cleanedRows || analysis.rawRows;
      const csv = convertJsonToCsv(rows);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${analysis.summary.name.replace(/\s+/g, '_')}_cleaned.csv"`);
      return res.send(csv);
    }

    if (type === 'cleaned_xlsx') {
      const rows = analysis.cleanedRows || analysis.rawRows;
      const ws = XLSX.utils.json_to_sheet(rows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Cleaned_Data');
      const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${analysis.summary.name.replace(/\s+/g, '_')}_cleaned.xlsx"`);
      return res.send(buf);
    }

    if (type === 'issues_csv') {
      const issueRows = analysis.issues.map(iss => ({
        Issue_ID: iss.id,
        Category: iss.category,
        Column: iss.column,
        Severity: iss.severity,
        Affected_Rows_Count: iss.affectedRows.length,
        Affected_Rows: iss.affectedRows.join('; '),
        Description: iss.description,
        Evidence: iss.evidence,
        Suggested_Action: iss.suggestedAction,
        Resolution_Status: iss.resolutionStatus,
        AI_Explanation: iss.aiExplanation?.simpleExplanation || ''
      }));
      const csv = convertJsonToCsv(issueRows);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${analysis.summary.name.replace(/\s+/g, '_')}_issues.csv"`);
      return res.send(csv);
    }

    if (type === 'corrections_csv') {
      const corRows = analysis.corrections.map(c => ({
        Correction_ID: c.id,
        Issue_ID: c.issueId,
        Row_Reference: c.rowRef,
        Column: c.column,
        Original_Value: c.originalValue,
        Proposed_Value: c.proposedValue,
        Edited_Value: c.editedValue || '',
        Reason: c.reason,
        Source: c.source,
        Status: c.status
      }));
      const csv = convertJsonToCsv(corRows);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${analysis.summary.name.replace(/\s+/g, '_')}_corrections.csv"`);
      return res.send(csv);
    }

    res.status(400).send('Invalid download type specified.');
  });

  // Download a previously-built subset as CSV. Re-applies the stored spec to the
  // current rawRows via the SAME shared applySubsetSpec used at build time, so the
  // result is byte-identical to the build for an unchanged dataset (and reflects
  // any corrections applied since). Serialized via the existing convertJsonToCsv.
  app.get('/api/subset/download/:job_id/:subset_id', async (req: Request, res: Response) => {
    try {
      const analysis = await persistentStorage.get(req.params.job_id);
      if (!analysis) {
        return res.status(404).json({ error: 'Analysis job not found.' });
      }
      const stored = (analysis.subsets || []).find(s => s.subsetId === req.params.subset_id);
      if (!stored) {
        return res.status(404).json({ error: 'Subset not found.' });
      }
      const { rows } = applySubsetSpec(analysis.rawRows, stored.spec, analysis.columns);
      const csv = convertJsonToCsv(rows);
      const filename =
        (analysis.summary.name || 'dataset').replace(/\s+/g, '_') +
        '-subset-' + stored.subsetId + '.csv';
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      // An empty result set is valid: send the (possibly empty) body so the
      // browser still downloads a file rather than erroring.
      return res.send(csv);
    } catch (err: any) {
      console.error('Subset download failed:', err);
      res.status(500).json({ error: err.message || 'Could not download the subset.' });
    }
  });

  // Download a previously-built subset as XLSX. Re-applies the stored spec to
  // rawRows and streams as an Excel attachment.
  app.get('/api/subset/download-excel/:jobId/:subsetId', async (req: Request, res: Response) => {
    try {
      const { jobId, subsetId } = req.params;
      const analysis = await persistentStorage.get(jobId);
      if (!analysis) return res.status(404).json({ error: 'Analysis job not found.' });

      const stored = (analysis.subsets || []).find(s => s.subsetId === subsetId);
      if (!stored) return res.status(404).json({ error: 'Subset not found.' });

      const { rows } = applySubsetSpec(analysis.rawRows, stored.spec, analysis.columns);

      const ws = XLSX.utils.json_to_sheet(rows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Subset');
      const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

      const safeName = (stored.instruction || 'subset')
        .replace(/[^a-z0-9_\-\s]/gi, '')
        .trim()
        .replace(/\s+/g, '_')
        .slice(0, 50);

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName || 'subset'}.xlsx"`);
      res.send(buf);
    } catch (err: any) {
      console.error('Excel download failed:', err);
      res.status(500).json({ error: err.message || 'Failed to generate Excel file.' });
    }
  });

  // Serve frontend: Vite middleware in development or static dist in production
  if (process.env.NODE_ENV === 'production') {
    app.use(express.static('dist'));
    app.get('*', async (req: Request, res: Response) => {
      res.sendFile(path.resolve(process.cwd(), 'dist', 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`\n✅ DataAId Full-Stack Server is running!\n`);
    console.log(`   Local:   http://localhost:${PORT}`);
    console.log(`   Network: http://127.0.0.1:${PORT}\n`);
    console.log(`👉 Open your browser and go to: http://localhost:${PORT}\n`);
  });
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
});
