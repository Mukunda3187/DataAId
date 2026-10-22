import { QualityIssue, CorrectionItem, AnalysisResult } from '../types/dataQuality';
import { profileDataset } from './profiler';
import { calculateQualityScore } from './scoringEngine';
import { detectDateColumnFormat, correctDateValue } from './qualityDetector';
import { inferMissingValueFromSurroundingRows, generateSimilarEmailFromDataset } from './contextImputer';

export function generateCorrectionsFromIssues(
  issues: QualityIssue[],
  rawRows: Record<string, any>[]
): CorrectionItem[] {
  const corrections: CorrectionItem[] = [];

  for (const issue of issues) {
    if (issue.category === 'duplicate_record') {
      for (const rowRef of issue.affectedRows) {
        corrections.push({
          id: `COR-${issue.id}-${rowRef}`,
          issueId: issue.id,
          rowRef,
          column: 'Entire Row',
          originalValue: 'Duplicate Record',
          proposedValue: 'DROP_ROW',
          reason: 'Remove redundant duplicate row while preserving primary instance',
          source: 'heuristic_rule',
          status: 'pending'
        });
      }
    } else {
      for (const rowRef of issue.affectedRows) {
        const rowIdx = rowRef - 1;
        const origVal = rawRows[rowIdx] ? rawRows[rowIdx][issue.column] : '';
        
        let proposed = issue.proposedValue;
        let reason = issue.suggestedAction || issue.description;
        let alternates: string[] = issue.alternateSuggestions || [];

        // Special handling for missing values: examine UP and DOWN rows context to infer similar text
        if (issue.category === 'missing_value') {
          if (/email/i.test(issue.column)) {
            // For email columns: generate a similar email from dataset patterns
            const emailInference = generateSimilarEmailFromDataset(rawRows, rowIdx, issue.column);
            proposed = emailInference.proposedValue;
            alternates = emailInference.alternates;
            reason = emailInference.reason;
          } else {
            const inference = inferMissingValueFromSurroundingRows(rawRows, rowIdx, issue.column);
            proposed = inference.proposedValue;
            alternates = inference.alternates;
            reason = inference.reason;
          }
        } 
        // Invalid email syntax: build a row-specific suggestion from the dataset's
        // dominant email domain/naming convention instead of leaving proposedValue blank.
        if (issue.category === 'invalid_format' && /email/i.test(issue.column)) {
          const emailInference = generateSimilarEmailFromDataset(rawRows, rowIdx, issue.column);
          proposed = emailInference.proposedValue;
          alternates = emailInference.alternates;
          reason = `Suggested from the dataset's email domain/naming pattern. Verify against the person's real contact details before applying.`;
        }

        // Date format correction: detect the column's format from the actual data,
        // then normalize this row's value to the SAME format + separator
        else if (
          issue.category === 'invalid_format' &&
          !/email/i.test(issue.column) &&
          !(/^time$/i.test(issue.column.trim())) &&
          (/date|created|updated|dob/i.test(issue.column) || /time/i.test(issue.column))
        ) {
          const { sep, order } = detectDateColumnFormat(rawRows, issue.column);
          const raw = String(origVal ?? '').trim();

          // Normalize: parse using detected format, rebuild in detected format+sep
          const parts = raw.split(sep);
          if (parts.length === 3) {
            const nums = parts.map(p => parseInt(p, 10));
            let d: number, m: number, y: number;
            if (order === 'YMD')      { [y, m, d] = nums; }
            else if (order === 'MDY') { [m, d, y] = nums; }
            else                      { [d, m, y] = nums; }

            if (y >= 1000 && y <= 9999 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
              let normalized: string;
              if (order === 'YMD')
                normalized = [String(y).padStart(4,'0'), String(m).padStart(2,'0'), String(d).padStart(2,'0')].join(sep);
              else if (order === 'MDY')
                normalized = [String(m).padStart(2,'0'), String(d).padStart(2,'0'), String(y).padStart(4,'0')].join(sep);
              else
                normalized = [String(d).padStart(2,'0'), String(m).padStart(2,'0'), String(y).padStart(4,'0')].join(sep);

              proposed = normalized;
              const orderLabel = order === 'YMD'
                ? `YYYY${sep}MM${sep}DD`
                : order === 'MDY'
                ? `MM${sep}DD${sep}YYYY`
                : `DD${sep}MM${sep}YYYY`;
              reason = `Normalized date from "${raw}" to "${normalized}" (${orderLabel} format).`;
              alternates = [normalized];
            } else {
              // Parts don't parse cleanly — try day/month swap
              const corrected = correctDateValue(raw, sep, order);
              if (corrected) {
                proposed = corrected;
                reason = `Corrected date "${raw}" → "${corrected}" (day/month swapped to match ${sep === '/' ? 'slash' : sep}-separated format).`;
                alternates = [corrected];
              } else {
                proposed = issue.proposedValue ?? origVal;
              }
            }
          } else {
            // Different separator or unparseable — use issue's proposedValue
            proposed = issue.proposedValue ?? origVal;
          }
        } else if (issue.aiExplanation?.proposedCorrection) {
          proposed = issue.aiExplanation.proposedCorrection;
        }

        corrections.push({
          id: `COR-${issue.id}-${rowRef}`,
          issueId: issue.id,
          rowRef,
          column: issue.column,
          originalValue: origVal === undefined ? '' : origVal,
          proposedValue: proposed !== undefined ? proposed : '',
          reason,
          source: issue.aiExplanation ? 'genai' : 'heuristic_rule',
          status: 'pending',
          alternateSuggestions: alternates
        });
      }
    }
  }

  return corrections;
}

export function previewCorrectionsDiff(
  rawRows: Record<string, any>[],
  corrections: CorrectionItem[]
): {
  totalModifiedCells: number;
  totalDroppedRows: number;
  diffs: { rowRef: number; column: string; before: any; after: any; status: string }[];
} {
  const approvedCorrections = corrections.filter(c => c.status === 'approved');
  let totalDroppedRows = 0;
  let totalModifiedCells = 0;
  const diffs: { rowRef: number; column: string; before: any; after: any; status: string }[] = [];

  for (const item of approvedCorrections) {
    const finalVal = item.editedValue !== undefined ? item.editedValue : item.proposedValue;
    if (finalVal === 'DROP_ROW') {
      totalDroppedRows++;
      diffs.push({
        rowRef: item.rowRef,
        column: 'Entire Row',
        before: 'Active Row',
        after: 'DELETED / DEDUPLICATED',
        status: item.status
      });
    } else {
      totalModifiedCells++;
      diffs.push({
        rowRef: item.rowRef,
        column: item.column,
        before: item.originalValue,
        after: finalVal,
        status: item.status
      });
    }
  }

  return { totalModifiedCells, totalDroppedRows, diffs };
}

export function applyApprovedCorrections(analysis: AnalysisResult): AnalysisResult {
  // Deep clone rawRows to preserve original dataset integrity
  const newCleanedRows: Record<string, any>[] = JSON.parse(JSON.stringify(analysis.rawRows));
  const rowsToDrop = new Set<number>();
  let appliedCount = 0;

  for (const item of analysis.corrections) {
    if (item.status === 'approved') {
      const finalVal = item.editedValue !== undefined ? item.editedValue : item.proposedValue;
      const rowIdx = item.rowRef - 1;

      if (finalVal === 'DROP_ROW') {
        rowsToDrop.add(rowIdx);
        item.status = 'applied';
        appliedCount++;
      } else if (newCleanedRows[rowIdx]) {
        newCleanedRows[rowIdx][item.column] = finalVal;
        item.status = 'applied';
        appliedCount++;
      }
    }
  }

  // Filter out dropped duplicate rows
  const finalCleanedRows = newCleanedRows.filter((_, idx) => !rowsToDrop.has(idx));

  // Mark resolved issues (those whose corrections are all applied)
  const updatedIssues = analysis.issues.map(iss => {
    const relCorrections = analysis.corrections.filter(c => c.issueId === iss.id);
    if (relCorrections.length > 0 && relCorrections.every(c => c.status === 'applied')) {
      return { ...iss, resolutionStatus: 'applied' as const };
    }
    return iss;
  });

  // Re-profile columns for updated counts — but DO NOT re-detect issues
  // Issues are only refreshed when user explicitly clicks Rescan
  const reProfiledColumns = profileDataset(finalCleanedRows);
  // Carry over issuesCount from the existing columns mapping
  for (const col of reProfiledColumns) {
    col.issuesCount = updatedIssues.filter(iss => iss.column === col.name && iss.resolutionStatus !== 'applied').length;
  }

  // Keep only non-applied corrections so the correction list stays accurate
  const remainingCorrections = analysis.corrections.filter(c => c.status !== 'applied');

  // Calculate score after corrections based on remaining unresolved issues
  const unresolvedIssues = updatedIssues.filter(i => i.resolutionStatus !== 'applied' && i.resolutionStatus !== 'rejected');
  const scoreAfter = calculateQualityScore(
    finalCleanedRows.length,
    reProfiledColumns,
    unresolvedIssues,
    analysis.scoreBefore.weights
  );

  const timestamp = new Date().toISOString();
  const commitHash = Math.random().toString(16).substring(2, 9);
  const scoreDelta = scoreAfter.overall - analysis.scoreBefore.overall;
  const historyLog = [
    ...analysis.historyLog,
    {
      hash: commitHash,
      timestamp,
      action: `Applied ${appliedCount} Approved Corrections`,
      author: 'User (Verified)',
      details: `Successfully applied ${appliedCount} corrections. Dropped ${rowsToDrop.size} duplicate rows. Quality score: ${analysis.scoreBefore.overall}% → ${scoreAfter.overall}% (${scoreDelta >= 0 ? '+' : ''}${scoreDelta}%). Click Rescan to detect any new issues.`,
      type: 'apply' as const,
      stats: {
        appliedCount,
        rowsAffected: appliedCount,
        scoreBefore: analysis.scoreBefore.overall,
        scoreAfter: scoreAfter.overall,
        scoreDelta
      }
    }
  ];

  const updatedName = analysis.summary.name.includes('(Updated Dataset)')
    ? analysis.summary.name
    : `${analysis.summary.name} (Updated Dataset)`;

  return {
    ...analysis,
    rawRows: finalCleanedRows,
    cleanedRows: finalCleanedRows,
    columns: reProfiledColumns,
    issues: updatedIssues,
    corrections: remainingCorrections,
    scoreBefore: scoreAfter,
    scoreAfter,
    appliedCorrectionsCount: analysis.appliedCorrectionsCount + appliedCount,
    historyLog,
    summary: {
      ...analysis.summary,
      name: updatedName,
      rowCount: finalCleanedRows.length,
      status: 'completed'
    }
  };
}
