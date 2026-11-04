/**
 * src/services/analyticsEngine.ts
 *
 * Pure analytics engine — no network calls, no Gemini.
 * Parses natural-language question intent and computes exact statistics
 * from rawRows so Gemini only needs to explain results, not recalculate them.
 */

import { ColumnProfile, AnalysisResult } from '../types/dataQuality.js';

// ---------------------------------------------------------------------------
// Shared normalizer (mirrors geminiService normColumn without importing it to
// avoid a circular import risk at runtime).
// ---------------------------------------------------------------------------
function normCol(name: string): string {
  return name.trim().toLowerCase().replace(/[_\s]+/g, '');
}

function fuzzyMatch(name: string, columns: ColumnProfile[]): string | undefined {
  const target = normCol(name);
  for (const c of columns) {
    if (normCol(c.name) === target) return c.name;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// ParsedIntent — exported interface consumed by server.ts and tests
// ---------------------------------------------------------------------------
export interface ParsedIntent {
  type:
    | 'row_lookup'
    | 'aggregation'
    | 'filter_query'
    | 'column_info'
    | 'top_n'
    | 'general'
    | 'comparison'
    | 'distribution';
  columns?: string[];          // referenced column names (real, validated)
  rowNumber?: number;          // for row_lookup
  aggregation?: 'avg' | 'sum' | 'min' | 'max' | 'count' | 'median';
  filterColumn?: string;
  filterValue?: string;
  topN?: number;
  groupBy?: string;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
}

// ---------------------------------------------------------------------------
// ComputedFact — one fact returned from computeDatasetAnalytics
// ---------------------------------------------------------------------------
export interface ComputedFact {
  label: string;
  value: any;
  unit?: string;
}

// ---------------------------------------------------------------------------
// parseQuestionIntent
// ---------------------------------------------------------------------------
export function parseQuestionIntent(
  question: string,
  columnNames: string[],
  columnProfiles?: ColumnProfile[]
): ParsedIntent {
  const q = question.trim();
  const ql = q.toLowerCase();

  // Build a lightweight ColumnProfile[] for fuzzy matching when only names are given
  const profiles: ColumnProfile[] = columnProfiles ?? columnNames.map(n => ({
    name: n,
    dataType: 'string' as const,
    nonNullCount: 0,
    missingCount: 0,
    missingPercentage: 0,
    uniqueCount: 0,
    uniquePercentage: 0,
    sampleValues: [],
    frequentValues: [],
    issuesCount: 0,
  }));

  // Helper: find a column name anywhere in the question
  function findColumn(): string | undefined {
    // Try multi-word tokens first (longer first) for best match
    const tokens = q.split(/\s+/);
    for (let len = tokens.length; len >= 1; len--) {
      for (let i = 0; i <= tokens.length - len; i++) {
        const candidate = tokens.slice(i, i + len).join(' ');
        const m = fuzzyMatch(candidate, profiles);
        if (m) return m;
      }
    }
    return undefined;
  }

  // Helper: match column from a pattern capture group
  function matchedCol(candidate?: string): string[] {
    if (!candidate) return [];
    const m = fuzzyMatch(candidate.trim(), profiles);
    return m ? [m] : [];
  }

  // 1. Row lookup — "show row 15", "row number 15", "customer number 15", "record 15"
  const rowLookupMatch = ql.match(
    /\b(?:row\s*(?:number|no\.?|#)?\s*|customer\s*(?:number|no\.?)\s*|record\s*)(\d+)\b/i
  );
  if (rowLookupMatch) {
    return { type: 'row_lookup', rowNumber: Number(rowLookupMatch[1]) };
  }

  // 2. Count / how many
  if (/\b(count|how\s+many|number\s+of\s+rows?|total\s+rows?)\b/i.test(ql) && !/\bmissing\b/i.test(ql)) {
    return { type: 'aggregation', aggregation: 'count' };
  }

  // 3. Average / mean
  const avgMatch = ql.match(/\b(?:average|avg|mean)\s+(?:of\s+)?(\w[\w\s]*)/i);
  if (avgMatch) {
    const col = findColumn();
    return { type: 'aggregation', aggregation: 'avg', columns: matchedCol(col || avgMatch[1]) };
  }

  // 4. Max / highest / maximum / largest
  const maxMatch = ql.match(/\b(?:highest|maximum|max|largest|most)\s+(?:\w+\s+)?(?:of\s+)?(\w[\w\s]*)/i);
  if (maxMatch) {
    // "which city has most customers" → distribution, not max
    if (/\b(?:city|cities|country|region)\b/i.test(ql) && /\bcustomers?\b/i.test(ql)) {
      const col = findColumn() || matchedCol(maxMatch[1])[0];
      return { type: 'distribution', groupBy: col };
    }
    const col = findColumn();
    return { type: 'aggregation', aggregation: 'max', columns: matchedCol(col || maxMatch[1]) };
  }

  // 5. Min / lowest / minimum / smallest
  const minMatch = ql.match(/\b(?:lowest|minimum|min|smallest)\s+(?:\w+\s+)?(?:of\s+)?(\w[\w\s]*)/i);
  if (minMatch) {
    const col = findColumn();
    return { type: 'aggregation', aggregation: 'min', columns: matchedCol(col || minMatch[1]) };
  }

  // 6. Sum / total
  const sumMatch = ql.match(/\b(?:sum|total)\s+(?:of\s+)?(\w[\w\s]*)/i);
  if (sumMatch) {
    const col = findColumn();
    return { type: 'aggregation', aggregation: 'sum', columns: matchedCol(col || sumMatch[1]) };
  }

  // 7. Median
  const medianMatch = ql.match(/\bmedian\s+(?:of\s+)?(\w[\w\s]*)/i);
  if (medianMatch) {
    const col = findColumn();
    return { type: 'aggregation', aggregation: 'median', columns: matchedCol(col || medianMatch[1]) };
  }

  // 8. Top N — "top N records by col" / "top N col"
  const topNMatch = ql.match(/\btop\s+(\d+)\b/i);
  if (topNMatch) {
    const n = Number(topNMatch[1]);
    // Try to find "by <col>" pattern
    const byMatch = ql.match(/\bby\s+(\w[\w\s]*?)(?:\s*$|\s+(?:in|from|of|and))/i);
    const col = byMatch ? fuzzyMatch(byMatch[1].trim(), profiles) : findColumn();
    return { type: 'top_n', topN: n, columns: col ? [col] : [], sortDir: 'desc' };
  }

  // 9. Distribution / which X has most
  if (/\b(?:which\s+\w+\s+has\s+(?:most|highest|most\s+number)|distribution\s+of|breakdown\s+of|frequency\s+of)\b/i.test(ql)) {
    const col = findColumn();
    return { type: 'distribution', groupBy: col };
  }

  // 10. Missing values
  if (/\bmissing\s+values?\b/i.test(ql) || /\b(?:null|empty|blank)\s+values?\b/i.test(ql)) {
    return { type: 'column_info', aggregation: 'count' };
  }

  // 11. Column info — "explain X column" / "describe X column"
  const columnInfoMatch = ql.match(/\b(?:explain|describe|what\s+is|tell\s+me\s+about)\b.+\bcolumn\b/i)
    || ql.match(/\bcolumn\b.+\b(?:explain|describe|info|information|details?)\b/i);
  if (columnInfoMatch) {
    const col = findColumn();
    return { type: 'column_info', columns: col ? [col] : [] };
  }

  // 12. Default: general
  return { type: 'general' };
}

// ---------------------------------------------------------------------------
// computeDatasetAnalytics
// ---------------------------------------------------------------------------
export function computeDatasetAnalytics(
  analysis: AnalysisResult,
  intent: ParsedIntent
): ComputedFact[] {
  try {
    const rows = analysis.rawRows || [];
    const columns = analysis.columns || [];

    if (intent.type === 'general') return [];

    // ── Aggregation ──────────────────────────────────────────────────────────
    if (intent.type === 'aggregation') {
      const agg = intent.aggregation;

      if (agg === 'count') {
        // With filterColumn: count rows where column is not blank
        if (intent.filterColumn && intent.filterValue) {
          const fc = intent.filterColumn;
          const fv = intent.filterValue.toLowerCase();
          const count = rows.filter(r => String(r[fc] ?? '').toLowerCase() === fv).length;
          return [{ label: `Count where ${fc} = ${intent.filterValue}`, value: count }];
        }
        return [{ label: 'Total rows', value: rows.length }];
      }

      const colName = intent.columns?.[0];
      if (!colName) return [];

      const numericValues: number[] = [];
      for (const row of rows) {
        const raw = row[colName];
        if (raw === null || raw === undefined || raw === '') continue;
        const n = Number(raw);
        if (Number.isFinite(n)) numericValues.push(n);
      }

      if (numericValues.length === 0) return [];

      if (agg === 'avg') {
        const avg = numericValues.reduce((a, b) => a + b, 0) / numericValues.length;
        return [{ label: `Average ${colName}`, value: Math.round(avg * 100) / 100 }];
      }
      if (agg === 'sum') {
        const sum = numericValues.reduce((a, b) => a + b, 0);
        return [{ label: `Sum of ${colName}`, value: Math.round(sum * 100) / 100 }];
      }
      if (agg === 'min') {
        return [{ label: `Minimum ${colName}`, value: Math.min(...numericValues) }];
      }
      if (agg === 'max') {
        return [{ label: `Maximum ${colName}`, value: Math.max(...numericValues) }];
      }
      if (agg === 'median') {
        const sorted = [...numericValues].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        const median = sorted.length % 2 === 0
          ? (sorted[mid - 1] + sorted[mid]) / 2
          : sorted[mid];
        return [{ label: `Median ${colName}`, value: Math.round(median * 100) / 100 }];
      }
    }

    // ── Row lookup ────────────────────────────────────────────────────────────
    if (intent.type === 'row_lookup') {
      const rowIdx = (intent.rowNumber ?? 1) - 1;
      if (rowIdx < 0 || rowIdx >= rows.length) {
        return [{ label: 'Row lookup', value: null }];
      }
      return [{ label: `Row ${intent.rowNumber}`, value: JSON.stringify(rows[rowIdx]) }];
    }

    // ── Top N ─────────────────────────────────────────────────────────────────
    if (intent.type === 'top_n') {
      const n = intent.topN ?? 5;
      const colName = intent.columns?.[0];
      if (!colName) return [];
      const colDef = columns.find(c => c.name === colName);
      const isNum = colDef?.dataType === 'number';
      const dir = intent.sortDir === 'asc' ? 1 : -1;
      const sorted = [...rows].sort((a, b) => {
        if (isNum) {
          const an = Number(a[colName]);
          const bn = Number(b[colName]);
          if (Number.isFinite(an) && Number.isFinite(bn)) return (an - bn) * dir;
          if (Number.isFinite(an)) return -1 * dir;
          if (Number.isFinite(bn)) return 1 * dir;
          return 0;
        }
        return String(a[colName] ?? '').localeCompare(String(b[colName] ?? '')) * dir;
      });
      return [{ label: `Top ${n} by ${colName}`, value: JSON.stringify(sorted.slice(0, n)) }];
    }

    // ── Distribution / group by ───────────────────────────────────────────────
    if (intent.type === 'distribution') {
      const colName = intent.groupBy ?? intent.columns?.[0];
      if (!colName) return [];
      const counts: Record<string, number> = {};
      for (const row of rows) {
        const key = String(row[colName] ?? '(blank)');
        counts[key] = (counts[key] || 0) + 1;
      }
      const sorted = Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .map(([value, count]) => `${value}: ${count}`)
        .join(', ');
      return [{ label: `Distribution of ${colName}`, value: sorted }];
    }

    // ── Column info ───────────────────────────────────────────────────────────
    if (intent.type === 'column_info') {
      // Missing values summary (no specific column)
      if (intent.aggregation === 'count') {
        const facts: ComputedFact[] = [];
        for (const col of columns) {
          if (col.missingCount > 0) {
            facts.push({ label: `${col.name} missing`, value: col.missingCount });
          }
        }
        const totalMissing = columns.reduce((acc, c) => acc + c.missingCount, 0);
        facts.push({ label: 'Total missing values', value: totalMissing });
        return facts;
      }

      // Specific column info
      const colName = intent.columns?.[0];
      if (!colName) return [];
      const colDef = columns.find(c => c.name === colName);
      if (!colDef) return [];
      return [
        { label: `${colName} type`, value: colDef.dataType },
        { label: `${colName} missing count`, value: colDef.missingCount },
        { label: `${colName} unique count`, value: colDef.uniqueCount },
        { label: `${colName} min`, value: colDef.min ?? 'N/A' },
        { label: `${colName} max`, value: colDef.max ?? 'N/A' },
        { label: `${colName} mean`, value: colDef.mean ?? 'N/A' },
      ];
    }

    return [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// classifyDatamateIntent_testable — exported pure helper for tests
// This mirrors the classifyDatamateIntent logic in server.ts without importing
// from server.ts (which would spin up Express).
// ---------------------------------------------------------------------------
export function classifyDatamateIntent_testable(
  message: string,
  columns: Array<{ name: string }> = []
): 'build' | 'question' {
  // Explicit row-number requests are deterministic data retrieval.
  if (/\brows?\s+(?:number\s+|no\.\s*)?(?:#\s*)?\d+(?:\s*(?:,|and)\s*\d+)*\b/i.test(message)) return 'build';

  // "give/show N columns and N rows" — slice both axes
  if (/\b\d+\s+columns?\b/i.test(message) && /\b\d+\s+rows?\b/i.test(message)) return 'build';

  // "give/show N rows" with a retrieval verb — return first N rows
  if (/\b(?:give|show|get|fetch|display|return|extract|pull)\b[\s\S]{0,30}\b\d+\s+rows?\b/i.test(message)) return 'build';

  // Column-specific missing value requests
  if (/\b(?:missing|null|empty|blank)\b/i.test(message) && /\b(?:rows?|records?|entries)\b/i.test(message)) return 'build';
  if (/\b(?:rows?|records?)\s+(?:in\s+which|where|with|that\s+have?|having)\b[\s\S]{0,40}\b(?:missing|null|empty|blank|no\s+value)\b/i.test(message)) return 'build';
  if (/\b(?:missing|null|empty|blank)\b[\s\S]{0,40}\b(?:rows?|records?|entries|exist|found)\b/i.test(message)) return 'build';

  // Retrieval verbs followed by a real dataset column
  const asksForData = /^\s*(?:show|give|fetch|list|display|return|extract|get|download)\b/i.test(message);
  if (asksForData && columns.some(column => {
    const tokens = column.name.trim().split(/[_\s-]+/).filter(Boolean);
    if (!tokens.length) return false;
    const escaped = tokens.map(token => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return new RegExp(`\\b${escaped.join('[_\\s-]+')}\\b`, 'i').test(message);
  })) return 'build';

  // Filter patterns
  if (/\brows\s+where\b/i.test(message)) return 'build';
  if (/\bonly\s+rows\b/i.test(message)) return 'build';
  if (/\brows\s+that\b/i.test(message)) return 'build';
  if (/\brows\s+with\b/i.test(message)) return 'build';
  if (/\brows\s+having\b/i.test(message)) return 'build';

  // Projection
  if (/\bcolumns\s+[\w.]*(?:\s*,\s*[\w.]+)+/i.test(message)) return 'build';

  // Row slicing: "top/first/last N rows", "limit N", "top N products/records"
  if (/\b(?:top|first|last)\s+\d+\s+rows?\b/i.test(message)) return 'build';
  if (/\b(?:top|first|last)\s+\d+\s+(?:products?|records?|entries|items|results?|customers?|sales?|highest|lowest)\b/i.test(message)) return 'build';
  if (/\blimit\s+\d+\b/i.test(message)) return 'build';

  // Explicit subset keywords
  if (/\b(?:subset|sub\s*dataset|sub-dataset|custom\s+dataset)\b/i.test(message)) return 'build';

  // Verb + dataset/subset
  if (/\b(?:create|build|make|generate|extract|give)\b[\s\S]{0,40}\b(?:dataset|subset)\b/i.test(message)) return 'build';

  // Where clause
  if (/\bwhere\b\s+[\w.]+\s*(?:=|!=|>=|<=|>|<|equals|contains)\s*\S/i.test(message)) return 'build';

  // With clause
  if (/\bwith\b\s+[\w.\s]+\s*(?:=|!=|>=|<=|>|<|equals|contains)\s*\S/i.test(message)) return 'build';
  if (/\bwith\s+[\w]+(?:\s+[\w]+)?\s+\d+\b/i.test(message)) return 'build';

  // Data retrieval verbs
  if (/\b(?:give|show|find|get|list|fetch|display|return|extract|pull)\b[\s\S]{0,60}\b(?:rows?|records?|entries|ids?|values?|data|missing|existing|all)\b/i.test(message)) return 'build';

  // Missing value rows
  if (/\b(?:missing[\s_]?values?\s+(?:rows?|records?|entries)|rows?\s+with\s+missing|existing\s+rows?)\b/i.test(message)) return 'build';

  return 'question';
}
