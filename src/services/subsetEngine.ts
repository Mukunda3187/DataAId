import { SubsetSpec, SubsetCondition, ColumnProfile } from '../types/dataQuality';

export interface AppliedSubset {
  rows: Record<string, any>[];   // projected, filtered, distincted, limited
  columns: string[];             // output column names in order
}

function isBlank(value: any): boolean {
  return value === null || value === undefined || value === '';
}

function valuesEqual(rowVal: any, condVal: any, isNumberCol: boolean): boolean {
  if (isNumberCol) {
    const rn = Number(rowVal);
    const cn = Number(condVal);
    if (!Number.isFinite(rn) || !Number.isFinite(cn)) return false;
    return rn === cn;
  }
  return String(rowVal ?? '').toLowerCase() === String(condVal ?? '').toLowerCase();
}

function compareOrdered(
  rowVal: any,
  condVal: any,
  isNumberCol: boolean,
  operator: 'gt' | 'gte' | 'lt' | 'lte'
): boolean {
  if (isNumberCol) {
    const rn = Number(rowVal);
    const cn = Number(condVal);
    // A row value that does not coerce to a finite number fails the condition.
    if (!Number.isFinite(rn) || !Number.isFinite(cn)) return false;
    if (operator === 'gt') return rn > cn;
    if (operator === 'gte') return rn >= cn;
    if (operator === 'lt') return rn < cn;
    return rn <= cn; // 'lte'
  }
  // Non-number column: lexicographic string comparison.
  const rs = String(rowVal ?? '');
  const cs = String(condVal ?? '');
  if (operator === 'gt') return rs > cs;
  if (operator === 'gte') return rs >= cs;
  if (operator === 'lt') return rs < cs;
  return rs <= cs; // 'lte'
}

// Evaluate a single condition against a row. Unknown columns are skipped
// (treated as always-true) so a corrupt stored spec never crashes the engine.
function evalCondition(
  row: Record<string, any>,
  cond: SubsetCondition,
  columns: ColumnProfile[]
): boolean {
  const col = columns.find(c => c.name === cond.column);
  if (!col) return true; // unknown column -> skip condition (crash-free)
  const isNumberCol = col.dataType === 'number';
  const rowVal = row[cond.column];
  const condVal = cond.value;

  switch (cond.operator) {
    case 'equals':
      return valuesEqual(rowVal, condVal, isNumberCol);
    case 'notEquals':
      return !valuesEqual(rowVal, condVal, isNumberCol);
    case 'contains':
      return String(rowVal ?? '').toLowerCase().includes(String(condVal ?? '').toLowerCase());
    case 'isNull':
      return isBlank(rowVal);
    case 'notNull':
      return !isBlank(rowVal);
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      return compareOrdered(rowVal, condVal, isNumberCol, cond.operator);
    case 'in': {
      // value is a comma-joined string; stringify first so a numeric value
      // never throws on .split. Membership reuses the equals coercion.
      const parts = String(condVal ?? '').split(',').map(p => p.trim());
      return parts.some(p => valuesEqual(rowVal, p, isNumberCol));
    }
    default:
      return true; // unknown operator -> skip condition
  }
}

/**
 * Pure, AI-free deterministic application of a (validated) SubsetSpec to raw
 * rows. Order is deliberate: filter (AND) -> project -> distinct -> limit,
 * yielding "the first N distinct projected rows that match the conditions".
 *
 * The spec is assumed already validated by the interpreter; this function does
 * NOT re-validate column names. Unknown columns/conditions are skipped rather
 * than thrown so a corrupt stored spec can never crash the download endpoint.
 * Shared by both /api/ai/build-subset and /api/subset/download so results are
 * byte-identical for the same spec + rawRows.
 */
export function applySubsetSpec(
  rawRows: Record<string, any>[],
  spec: SubsetSpec,
  columns: ColumnProfile[]
): AppliedSubset {
  // 1. Output columns: validated includeColumns preserve the user's order;
  //    otherwise the dataset's natural column order.
  const outputColumns =
    spec.includeColumns && spec.includeColumns.length > 0
      ? spec.includeColumns.slice()
      : columns.map(c => c.name);

  // 2. Select explicitly requested 1-based data row numbers, then apply
  // column conditions. Row numbering excludes the header row.
  const requestedRows = Array.isArray(spec.rowNumbers) && spec.rowNumbers.length > 0
    ? new Set(spec.rowNumbers)
    : null;
  const rowSelected = rawRows.filter((_row, index) => !requestedRows || requestedRows.has(index + 1));

  // 3. Filter (AND or OR): a row passes if all (AND) or any (OR) condition passes.
  const conditions = spec.conditions || [];
  const useOR = spec.conditionLogic === 'OR';
  const filtered =
    conditions.length === 0
      ? rowSelected
      : rowSelected.filter(row =>
          useOR
            ? conditions.some(cond => evalCondition(row, cond, columns))
            : conditions.every(cond => evalCondition(row, cond, columns))
        );

  // 4. Project: keep only the output columns; absent columns become ''.
  const projected = filtered.map(row => {
    const out: Record<string, any> = {};
    for (const col of outputColumns) {
      out[col] = row[col] !== undefined ? row[col] : '';
    }
    return out;
  });

  // 5. Distinct: dedupe projected rows by serialized form, keeping first.
  let rows = projected;
  if (spec.distinct) {
    const seen = new Set<string>();
    rows = projected.filter(row => {
      const key = JSON.stringify(row);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // 5b. Sort: apply sort specs before limit
  if (Array.isArray(spec.sort) && spec.sort.length > 0) {
    const sortCols = spec.sort;
    rows = [...rows].sort((a, b) => {
      for (const { column, direction } of sortCols) {
        const col = columns.find(c => c.name === column);
        const isNum = col?.dataType === 'number';
        const av = a[column];
        const bv = b[column];
        let cmp: number;
        if (isNum) {
          const an = Number(av);
          const bn = Number(bv);
          // Treat NaN as infinity so non-numeric values sort to the end
          cmp = (Number.isFinite(an) ? an : Infinity) - (Number.isFinite(bn) ? bn : Infinity);
        } else {
          cmp = String(av ?? '').localeCompare(String(bv ?? ''));
        }
        if (cmp !== 0) return direction === 'asc' ? cmp : -cmp;
      }
      return 0;
    });
  }

  // 6. Limit: applied last so distinct counts are not truncated before dedup.
  if (
    typeof spec.limit === 'number' &&
    Number.isFinite(spec.limit) &&
    spec.limit > 0 &&
    Number.isInteger(spec.limit)
  ) {
    rows = rows.slice(0, spec.limit);
  }

  return { rows, columns: outputColumns };
}
