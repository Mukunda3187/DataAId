import express, { Request, Response } from 'express';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
import path from 'path';
import * as XLSX from 'xlsx';

import { AnalysisResult, DatasetSummary, AnalysisSettings, BusinessRule, QualityWeights } from './src/types/dataQuality';
import { profileDataset } from './src/services/profiler';
import { detectQualityIssues } from './src/services/qualityDetector';
import { calculateQualityScore, DEFAULT_WEIGHTS } from './src/services/scoringEngine';
import { generateCorrectionsFromIssues, previewCorrectionsDiff, applyApprovedCorrections } from './src/services/correctionEngine';
import { explainQualityIssueWithAI, isGeminiAvailable, generateMissingValueAlternatesAI } from './src/services/geminiService';

dotenv.config();

import { persistentStorage } from './src/services/storage';

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
  app.get('/api/status', (req: Request, res: Response) => {
    res.json({
      status: 'operational',
      genAiConnected: isGeminiAvailable(),
      model: isGeminiAvailable() ? 'gemini-3.8-flash' : 'Expert Heuristic Rule Engine (Predefined Demo Mode)',
      storage: 'Persistent Database Storage',
      activeAnalyses: persistentStorage.count()
    });
  });

  // Upload Dataset (CSV or Base64 XLSX)
  app.post('/api/upload', (req: Request, res: Response) => {
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

      if (fileType === 'xlsx' || fileName.endsWith('.xlsx') || fileName.endsWith('.xls')) {
        const buffer = Buffer.from(fileContent, 'base64');
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
        rows = parseCsv(fileContent);
      }

      if (!rows || rows.length === 0) {
        return res.status(400).json({ error: 'Uploaded file is empty or could not be parsed into tabular rows.' });
      }

      const jobId = `JOB-${Date.now()}`;
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
        status: 'awaiting_review'
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

      persistentStorage.set(jobId, analysis);
      res.json(analysis);
    } catch (err: any) {
      console.error('Error during dataset upload:', err);
      res.status(500).json({ error: err.message || 'Failed to process uploaded file.' });
    }
  });

  // Re-Analyze Dataset with updated settings or custom business rules
  app.post('/api/analyze', (req: Request, res: Response) => {
    try {
      const { jobId, settings, customRules, customWeights } = req.body;
      const analysis = persistentStorage.get(jobId);
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

      persistentStorage.set(jobId, analysis);
      res.json(analysis);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to re-analyze dataset.' });
    }
  });

  // Get Results by Job ID
  app.get('/api/results/:job_id', (req: Request, res: Response) => {
    const analysis = persistentStorage.get(req.params.job_id);
    if (!analysis) {
      return res.status(404).json({ error: 'Analysis job not found.' });
    }
    res.json(analysis);
  });

  // Get Issues by Job ID
  app.get('/api/issues/:job_id', (req: Request, res: Response) => {
    const analysis = persistentStorage.get(req.params.job_id);
    if (!analysis) {
      return res.status(404).json({ error: 'Analysis job not found.' });
    }
    res.json(analysis.issues);
  });

  // GenAI Explain Single Issue
  app.post('/api/ai/explain', async (req: Request, res: Response) => {
    try {
      const { jobId, issueId } = req.body;
      const analysis = persistentStorage.get(jobId);
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

      persistentStorage.set(jobId, analysis);
      res.json({ issue, explanation });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to generate AI explanation.' });
    }
  });

  // GenAI Explain All Issues in Job
  app.post('/api/ai/explain-all', async (req: Request, res: Response) => {
    try {
      const { jobId } = req.body;
      const analysis = persistentStorage.get(jobId);
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

      persistentStorage.set(jobId, analysis);
      res.json({ success: true, issues: analysis.issues });
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
  app.post('/api/corrections/preview', (req: Request, res: Response) => {
    const { jobId } = req.body;
    const analysis = persistentStorage.get(jobId);
    if (!analysis) {
      return res.status(404).json({ error: 'Analysis job not found.' });
    }

    const preview = previewCorrectionsDiff(analysis.rawRows, analysis.corrections);
    res.json(preview);
  });

  // Update Correction Items (Approve, Reject, or Edit proposed value)
  app.post('/api/corrections/update', (req: Request, res: Response) => {
    const { jobId, correctionId, status, editedValue, bulkAction, columnName, correctedRows } = req.body;
    const analysis = persistentStorage.get(jobId);
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

    persistentStorage.set(jobId, analysis);

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
  app.post('/api/rows/delete', (req: Request, res: Response) => {
    try {
      const { jobId, rowRef } = req.body;
      const analysis = persistentStorage.get(jobId);
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

        persistentStorage.set(jobId, analysis);
        return res.json(analysis);
      }
      return res.status(400).json({ error: 'Invalid row reference' });
    } catch (err: any) {
      console.error('Failed to delete row:', err);
      res.status(500).json({ error: err.message || 'Failed to delete row' });
    }
  });

  // Apply Approved Corrections
  app.post('/api/corrections/apply', (req: Request, res: Response) => {
    try {
      const { jobId, approveAll } = req.body;
      const analysis = persistentStorage.get(jobId);
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

      persistentStorage.set(jobId, updated);
      res.json(updated);
    } catch (err: any) {
      console.error('Failed to apply corrections:', err);
      res.status(500).json({ error: err.message || 'Failed to apply approved corrections.' });
    }
  });

  // Analysis History
  app.get('/api/history', (req: Request, res: Response) => {
    res.json(persistentStorage.listHistory());
  });

  // Detailed Report Data
  app.get('/api/report/:job_id', (req: Request, res: Response) => {
    const analysis = persistentStorage.get(req.params.job_id);
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
  app.get('/api/download/:job_id', (req: Request, res: Response) => {
    const { job_id } = req.params;
    const type = req.query.type as string; // 'cleaned_csv' | 'cleaned_xlsx' | 'issues_csv' | 'corrections_csv'
    const analysis = persistentStorage.get(job_id);

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

  // Serve frontend: Vite middleware in development or static dist in production
  if (process.env.NODE_ENV === 'production') {
    app.use(express.static('dist'));
    app.get('*', (req: Request, res: Response) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
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
