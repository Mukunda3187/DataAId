/**
 * Contextual & Statistical Imputation Engine
 * 1. Email Imputation: Generates matching emails based on existing dataset domain and row context.
 * 2. Heading-based Numerical Imputation: Selects Mean, Median, or Mode by analyzing column heading semantics.
 * 3. Text Imputation: Deduces similar text from surrounding rows.
 */

export interface SurroundingInference {
  proposedValue: string;
  reason: string;
  sourceRows: number[];
  alternates: string[];
}

export interface NumericalImputation {
  method: 'mean' | 'median' | 'mode';
  proposedValue: number | string;
  reason: string;
  stats: {
    mean: number;
    median: number;
    mode: number;
  };
}

/**
 * Checks if a value is non-empty and valid.
 */
function isValidValue(val: any): boolean {
  if (val === null || val === undefined) return false;
  const s = String(val).trim();
  if (s === '' || /^(null|none|nan|undefined|n\/a|--|\?)$/i.test(s)) return false;
  return true;
}

/**
 * Email Imputation: Analyzes existing emails in the dataset and generates a matching email
 * using the dominant domain and row-level context (e.g., Name, ID).
 */
export function generateSimilarEmailFromDataset(
  rawRows: Record<string, any>[],
  rowIdx: number,
  colName: string
): { proposedValue: string; reason: string; alternates: string[] } {
  // 1. Gather all existing valid emails from this column
  const existingEmails = rawRows
    .map(r => r[colName])
    .filter(isValidValue)
    .map(v => String(v).trim().toLowerCase())
    .filter(v => v.includes('@') && v.includes('.'));

  // 2. Identify the dominant domain
  const domainCounts = new Map<string, number>();
  for (const email of existingEmails) {
    const parts = email.split('@');
    if (parts.length === 2 && parts[1]) {
      const dom = parts[1];
      domainCounts.set(dom, (domainCounts.get(dom) || 0) + 1);
    }
  }

  const sortedDomains = Array.from(domainCounts.entries()).sort((a, b) => b[1] - a[1]);
  const dominantDomain = sortedDomains.length > 0 ? sortedDomains[0][0] : 'company.org';

  // 3. Inspect existing email naming structure (e.g. first.last vs first vs flast)
  let usesDot = false;
  if (existingEmails.length > 0) {
    const dotCount = existingEmails.filter(e => e.split('@')[0].includes('.')).length;
    usesDot = dotCount / existingEmails.length >= 0.4;
  }

  // 4. Inspect current row for Name or identifier fields
  const currentRow = rawRows[rowIdx] || {};
  let inferredUsername = '';

  for (const [key, val] of Object.entries(currentRow)) {
    if (!val || !isValidValue(val)) continue;
    const k = key.toLowerCase();
    const strVal = String(val).trim();

    if (/first.*name/i.test(k)) {
      const lastNameKey = Object.keys(currentRow).find(x => /last.*name/i.test(x));
      const lastNameVal = lastNameKey ? String(currentRow[lastNameKey] || '').trim() : '';
      if (lastNameVal) {
        inferredUsername = usesDot 
          ? `${cleanForEmail(strVal)}.${cleanForEmail(lastNameVal)}`
          : `${cleanForEmail(strVal)}${cleanForEmail(lastNameVal).charAt(0)}`;
        break;
      } else {
        inferredUsername = cleanForEmail(strVal);
        break;
      }
    }

    if (/name|full_name|person|contact|client|customer|employee/i.test(k) && typeof val === 'string') {
      const parts = strVal.split(/\s+/).filter(Boolean);
      if (parts.length >= 2) {
        inferredUsername = usesDot
          ? `${cleanForEmail(parts[0])}.${cleanForEmail(parts[parts.length - 1])}`
          : `${cleanForEmail(parts[0])}${cleanForEmail(parts[parts.length - 1]).charAt(0)}`;
      } else if (parts.length === 1) {
        inferredUsername = cleanForEmail(parts[0]);
      }
      break;
    }

    if (/id|code|emp|user_id/i.test(k)) {
      inferredUsername = cleanForEmail(strVal);
    }
  }

  // Fallback if no row identifier found: generate user{rowNum}
  if (!inferredUsername || inferredUsername.length < 2) {
    inferredUsername = `user${rowIdx + 1}`;
  }

  const generatedEmail = `${inferredUsername}@${dominantDomain}`;
  const reason = `Generated similar email ("${generatedEmail}") matching the dominant domain (@${dominantDomain}) from existing dataset records.`;

  // Also generate a couple more variants as alternates using other common names from the pool
  const firstNames = ['alex', 'sam', 'chris', 'taylor', 'jordan'];
  const lastNames = ['smith', 'jones', 'brown', 'davis', 'wilson'];
  const sep = usesDot ? '.' : '';
  const extraAlternates = firstNames.slice(0, 2).map(
    (f, i) => `${f}${sep}${lastNames[i]}@${dominantDomain}`
  ).filter(e => e !== generatedEmail);

  return { proposedValue: generatedEmail, reason, alternates: [generatedEmail, ...extraAlternates] };
}

function cleanForEmail(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Numerical Heading Imputation: Analyzes column heading and picks Mean, Median, or Mode.
 */
export function computeNumericalImputationByHeading(
  rawRows: Record<string, any>[],
  colName: string
): NumericalImputation {
  // Collect all valid numerical values
  const nums: number[] = [];
  for (const row of rawRows) {
    const val = row[colName];
    if (val !== null && val !== undefined && val !== '') {
      const n = Number(val);
      if (!isNaN(n)) {
        nums.push(n);
      }
    }
  }

  // Fallback default if column has no numeric values
  if (nums.length === 0) {
    return {
      method: 'median',
      proposedValue: 0,
      reason: 'No numerical values found in column; defaulted to 0.',
      stats: { mean: 0, median: 0, mode: 0 }
    };
  }

  // 1. Calculate Mean
  const sum = nums.reduce((acc, curr) => acc + curr, 0);
  const rawMean = sum / nums.length;
  const isAllInteger = nums.every(n => Number.isInteger(n));
  const mean = isAllInteger ? Math.round(rawMean) : Number(rawMean.toFixed(2));

  // 2. Calculate Median
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  let median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  median = isAllInteger ? Math.round(median) : Number(median.toFixed(2));

  // 3. Calculate Mode
  const freqMap = new Map<number, number>();
  for (const n of nums) {
    freqMap.set(n, (freqMap.get(n) || 0) + 1);
  }
  let maxFreq = 0;
  let mode = sorted[0];
  for (const [n, count] of freqMap.entries()) {
    if (count > maxFreq) {
      maxFreq = count;
      mode = n;
    }
  }

  const name = colName.toLowerCase();

  // HEADING ANALYSIS:
  // 1. Check for discrete ratings, star scores, rankings, codes, counts -> Choose MODE
  const isModeCandidate = 
    /rating|stars?|score_1_to_5|rank|tier|grade|priority|level|status_code|zip|postal|code|category_id|class|frequency|count|qty|quantity|units|items|children|dependents|num_orders/i.test(name) ||
    (isAllInteger && freqMap.size <= 8 && nums.length >= 10);

  if (isModeCandidate) {
    return {
      method: 'mode',
      proposedValue: mode,
      reason: `Imputed using column mode (${mode}) based on heading "${colName}" (optimal for discrete ratings, rankings, and counts).`,
      stats: { mean, median, mode }
    };
  }

  // 2. Check for monetary, financial, income, or heavy-tail continuous variables -> Choose MEDIAN
  const isMedianCandidate = 
    /price|cost|salary|compensation|income|wage|revenue|sales|profit|net_worth|budget|expense|valuation|fare|transaction|amount|balance|fee|loss|spend|age/i.test(name) ||
    (sorted[sorted.length - 1] > median * 4); // Significant skewness detected

  if (isMedianCandidate) {
    return {
      method: 'median',
      proposedValue: median,
      reason: `Imputed using column median (${median}) based on heading "${colName}" (optimal for monetary and skewed distributions, robust against outliers).`,
      stats: { mean, median, mode }
    };
  }

  // 3. Continuous measurements, ratios, averages, percentages -> Choose MEAN
  return {
    method: 'mean',
    proposedValue: mean,
    reason: `Imputed using column mean (${mean}) based on heading "${colName}" (optimal for continuous measurements, rates, and normalized metrics).`,
    stats: { mean, median, mode }
  };
}

/**
 * Text Imputation: Deduces similar text from surrounding rows.
 */
export function inferMissingValueFromSurroundingRows(
  rawRows: Record<string, any>[],
  rowIdx: number,
  colName: string
): SurroundingInference {
  const windowRadius = 5;
  const upValues: { val: string; rowNum: number }[] = [];
  const downValues: { val: string; rowNum: number }[] = [];

  // Inspect rows ABOVE (up)
  for (let i = rowIdx - 1; i >= Math.max(0, rowIdx - windowRadius); i--) {
    if (rawRows[i] && isValidValue(rawRows[i][colName])) {
      upValues.push({ val: String(rawRows[i][colName]).trim(), rowNum: i + 1 });
    }
  }

  // Inspect rows BELOW (down)
  for (let i = rowIdx + 1; i < Math.min(rawRows.length, rowIdx + windowRadius + 1); i++) {
    if (rawRows[i] && isValidValue(rawRows[i][colName])) {
      downValues.push({ val: String(rawRows[i][colName]).trim(), rowNum: i + 1 });
    }
  }

  const surroundingCounts = new Map<string, number>();
  const sourceRowRefs: number[] = [];

  if (upValues.length > 0) {
    const immediateUp = upValues[0];
    surroundingCounts.set(immediateUp.val, (surroundingCounts.get(immediateUp.val) || 0) + 3);
    sourceRowRefs.push(immediateUp.rowNum);
  }
  if (downValues.length > 0) {
    const immediateDown = downValues[0];
    surroundingCounts.set(immediateDown.val, (surroundingCounts.get(immediateDown.val) || 0) + 3);
    sourceRowRefs.push(immediateDown.rowNum);
  }

  for (let k = 1; k < upValues.length; k++) {
    surroundingCounts.set(upValues[k].val, (surroundingCounts.get(upValues[k].val) || 0) + 1);
    sourceRowRefs.push(upValues[k].rowNum);
  }
  for (let k = 1; k < downValues.length; k++) {
    surroundingCounts.set(downValues[k].val, (surroundingCounts.get(downValues[k].val) || 0) + 1);
    sourceRowRefs.push(downValues[k].rowNum);
  }

  const sortedSurrounding = Array.from(surroundingCounts.entries()).sort((a, b) => b[1] - a[1]);

  let proposedValue = '';
  let reason = '';

  if (sortedSurrounding.length > 0) {
    proposedValue = sortedSurrounding[0][0];
    reason = `Imputed with contextual value "${proposedValue}".`;
  }

  const alternates: string[] = sortedSurrounding.slice(0, 5).map(e => e[0]);

  if (!proposedValue) {
    const allColValues = rawRows
      .map(r => r[colName])
      .filter(isValidValue)
      .map(v => String(v).trim());

    const colCounts = new Map<string, number>();
    for (const v of allColValues) {
      colCounts.set(v, (colCounts.get(v) || 0) + 1);
    }
    const topColValues = Array.from(colCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(e => e[0]);

    if (topColValues.length > 0) {
      proposedValue = topColValues[0];
      reason = `Imputed with column mode ("${proposedValue}").`;
      alternates.push(...topColValues.slice(0, 5));
    } else {
      const cLower = colName.toLowerCase();
      if (/dept|department/i.test(cLower)) proposedValue = 'Operations';
      else if (/city/i.test(cLower)) proposedValue = 'Chicago';
      else if (/state/i.test(cLower)) proposedValue = 'CA';
      else if (/country|nation/i.test(cLower)) proposedValue = 'United States';
      else if (/status/i.test(cLower)) proposedValue = 'Active';
      else if (/category|type/i.test(cLower)) proposedValue = 'Standard';
      else if (/role|title/i.test(cLower)) proposedValue = 'Associate';
      else if (/priority/i.test(cLower)) proposedValue = 'Medium';
      else if (/segment/i.test(cLower)) proposedValue = 'Enterprise';
      else proposedValue = 'Standard';

      reason = `Imputed with standard category for "${colName}".`;
      alternates.push(proposedValue);
    }
  }

  return {
    proposedValue,
    reason,
    sourceRows: sourceRowRefs,
    alternates: alternates.length > 0 ? alternates : [proposedValue]
  };
}
