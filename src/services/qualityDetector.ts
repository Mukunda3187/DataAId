import { QualityIssue, AnalysisSettings, BusinessRule, ColumnProfile } from '../types/dataQuality';
import { isNumeric } from './profiler';
import { fixSwappedDateOrFormat } from './dateFixer';
import { computeNumericalImputationByHeading, generateSimilarEmailFromDataset } from './contextImputer';

const DEFAULT_CATEGORY_ALIASES: Record<string, string> = {
  'hyd': 'Hyderabad',
  'hyderabad': 'Hyderabad',
  'bangalore': 'Bengaluru',
  'bengaluru': 'Bengaluru',
  'bombay': 'Mumbai',
  'mumbai': 'Mumbai',
  'delhi ncr': 'Delhi',
  'new delhi': 'Delhi'
};

export function detectQualityIssues(
  jobId: string,
  rows: Record<string, any>[],
  columns: ColumnProfile[],
  settings: AnalysisSettings,
  customRules: BusinessRule[] = [],
  knownGoodColumns: string[] = []
): QualityIssue[] {
  const issues: QualityIssue[] = [];
  if (!rows || rows.length === 0) return issues;

  const totalRows = rows.length;
  let issueCounter = 1;
  const generateId = (prefix: string) => `ISS-${prefix}-${String(issueCounter++).padStart(4, '0')}`;

  // 1. Missing Values Detection
  for (const col of columns) {
    const missingRowIndices: number[] = [];
    for (let r = 0; r < totalRows; r++) {
      const val = rows[r][col.name];
      if (val === null || val === undefined || (typeof val === 'string' && val.trim() === '')) {
        missingRowIndices.push(r + 1); // 1-indexed for user readability
      }
    }

    if (missingRowIndices.length > 0) {
      const percentage = (missingRowIndices.length / totalRows) * 100;
      const isIdCol = /id|key|code/i.test(col.name);
      const severity = isIdCol ? 'critical' : percentage > 25 ? 'high' : percentage > 10 ? 'medium' : 'low';

      let suggestedAction = 'Impute with domain-appropriate value or verify source';
      let proposedValue: any = '';
      let alternateSuggestions: string[] = [];

      if (col.dataType === 'number') {
        const numImputation = computeNumericalImputationByHeading(rows, col.name);
        suggestedAction = numImputation.reason;
        proposedValue = numImputation.proposedValue;
      } else if (/email/i.test(col.name)) {
        const sampleEmail = generateSimilarEmailFromDataset(rows, missingRowIndices[0] - 1, col.name);
        proposedValue = sampleEmail.proposedValue;
        suggestedAction = sampleEmail.reason;
      } else {
        // Suggest intelligent contextual word & realistic alternates
        const validFrequent = (col.frequentValues || [])
          .map(f => f.value)
          .filter(v => v && v.trim() !== '' && !/null|none|nan|undefined|empty/i.test(v));
        const name = col.name.toLowerCase();
        
        if (validFrequent.length > 0) {
          proposedValue = validFrequent[0];
          suggestedAction = `Impute with contextual mode ("${proposedValue}")`;
          alternateSuggestions = Array.from(new Set([proposedValue, ...validFrequent.slice(1, 5)]));
        } else if (/city/i.test(name)) {
          proposedValue = 'Chicago';
          suggestedAction = 'Impute with representative regional hub ("Chicago")';
          alternateSuggestions = ['Chicago', 'New York', 'Seattle', 'Austin', 'San Francisco'];
        } else if (/state|province/i.test(name)) {
          proposedValue = 'CA';
          suggestedAction = 'Impute with standard state code ("CA")';
          alternateSuggestions = ['CA', 'NY', 'TX', 'IL', 'WA'];
        } else if (/country|nation/i.test(name)) {
          proposedValue = 'United States';
          suggestedAction = 'Impute with default country ("United States")';
          alternateSuggestions = ['United States', 'Canada', 'United Kingdom', 'Germany', 'Australia'];
        } else if (/region/i.test(name)) {
          proposedValue = 'North America';
          suggestedAction = 'Impute with standard region ("North America")';
          alternateSuggestions = ['North America', 'EMEA', 'APAC', 'LATAM'];
        } else if (/dept|department/i.test(name)) {
          proposedValue = 'Operations';
          suggestedAction = 'Impute with standard department ("Operations")';
          alternateSuggestions = ['Operations', 'Engineering', 'Marketing', 'Sales', 'Finance', 'Human Resources'];
        } else if (/status/i.test(name)) {
          proposedValue = 'Active';
          suggestedAction = 'Impute with baseline status ("Active")';
          alternateSuggestions = ['Active', 'Pending', 'Verified', 'Completed', 'Approved'];
        } else if (/category|type/i.test(name)) {
          proposedValue = 'Standard';
          suggestedAction = 'Impute with canonical category ("Standard")';
          alternateSuggestions = ['Standard', 'Premium', 'Enterprise', 'Basic'];
        } else if (/role|title/i.test(name)) {
          proposedValue = 'Associate';
          suggestedAction = 'Impute with standard role ("Associate")';
          alternateSuggestions = ['Associate', 'Manager', 'Analyst', 'Specialist', 'Lead'];
        } else if (/payment|method/i.test(name)) {
          proposedValue = 'Credit Card';
          suggestedAction = 'Impute with standard payment method ("Credit Card")';
          alternateSuggestions = ['Credit Card', 'Bank Transfer', 'Corporate Invoice', 'PayPal'];
        } else if (/priority/i.test(name)) {
          proposedValue = 'Medium';
          suggestedAction = 'Impute with standard priority ("Medium")';
          alternateSuggestions = ['Medium', 'High', 'Low', 'Critical'];
        } else if (/segment/i.test(name)) {
          proposedValue = 'Enterprise';
          suggestedAction = 'Impute with standard business segment ("Enterprise")';
          alternateSuggestions = ['Enterprise', 'Mid-Market', 'SMB', 'Consumer'];
        } else if (/tier|level/i.test(name)) {
          proposedValue = 'Tier 1';
          suggestedAction = 'Impute with default tier ("Tier 1")';
          alternateSuggestions = ['Tier 1', 'Tier 2', 'Tier 3', 'Premier'];
        } else if (/channel|source/i.test(name)) {
          proposedValue = 'Direct';
          suggestedAction = 'Impute with primary channel ("Direct")';
          alternateSuggestions = ['Direct', 'Online Portal', 'Partner Referral', 'In-Store'];
        } else if (/name|person|client|customer/i.test(name)) {
          proposedValue = 'Alex Morgan';
          suggestedAction = 'Impute with standard client moniker ("Alex Morgan")';
          alternateSuggestions = ['Alex Morgan', 'Jordan Lee', 'Taylor Smith', 'Sam Wilson'];
        } else if (/email/i.test(name)) {
          proposedValue = 'verified@corporate.org';
          suggestedAction = 'Impute with standard corporate email domain';
          alternateSuggestions = ['verified@corporate.org', 'contact@business.com', 'user@domain.com'];
        } else if (/date/i.test(name)) {
          proposedValue = new Date().toISOString().split('T')[0];
          suggestedAction = `Impute with current ISO date ("${proposedValue}")`;
          alternateSuggestions = [proposedValue, '2026-01-01', '2025-12-31'];
        } else {
          proposedValue = 'Standard';
          suggestedAction = 'Impute with suitable default value ("Standard")';
          alternateSuggestions = ['Standard', 'General', 'Default', 'Regular'];
        }
      }

      issues.push({
        id: generateId('MISS'),
        jobId,
        category: 'missing_value',
        column: col.name,
        affectedRows: missingRowIndices,
        severity,
        description: `Column "${col.name}" has ${missingRowIndices.length} missing or blank ${missingRowIndices.length === 1 ? 'value' : 'values'} (${percentage.toFixed(1)}% of total rows).`,
        evidence: `Empty strings/null values encountered in rows: ${missingRowIndices.slice(0, 5).join(', ')}${missingRowIndices.length > 5 ? '...' : ''}`,
        suggestedAction,
        proposedValue,
        resolutionStatus: 'pending',
        alternateSuggestions
      });
    }
  }

  // 2. Exact Duplicate Rows Detection
  if (settings.detectDuplicates) {
    const rowHashes = new Map<string, number[]>();
    for (let r = 0; r < totalRows; r++) {
      // Exclude empty keys, serialize row values
      const rowStr = JSON.stringify(rows[r], Object.keys(rows[r]).sort());
      const existing = rowHashes.get(rowStr);
      if (existing) {
        existing.push(r + 1);
      } else {
        rowHashes.set(rowStr, [r + 1]);
      }
    }

    const duplicateGroups = Array.from(rowHashes.entries()).filter(([_, indices]) => indices.length > 1);
    for (const [_, indices] of duplicateGroups) {
      // First occurrence is kept; subsequent are affected
      const redundantRows = indices.slice(1);
      issues.push({
        id: generateId('DUP'),
        jobId,
        category: 'duplicate_record',
        column: 'All Columns (Full Record)',
        affectedRows: redundantRows,
        severity: 'high',
        description: `Exact duplicate row detected matching primary row #${indices[0]}.`,
        evidence: `Row #${indices[0]} is identically repeated at row #${redundantRows.join(', #')}.`,
        suggestedAction: 'Deduplicate dataset by removing redundant row instances and preserving primary record.',
        proposedValue: 'DROP_ROW',
        resolutionStatus: 'pending'
      });
    }
  }

  // 3. Inconsistent Categories Detection
  if (settings.detectInconsistentCategories) {
    for (const col of columns) {
      if (col.dataType !== 'string' || col.uniqueCount > 50) continue;

      const rawValues = rows.map(r => r[col.name]).filter(v => v !== null && v !== undefined && String(v).trim() !== '');
      const uniqueVals = Array.from(new Set(rawValues.map(v => String(v).trim())));

      // Group by normalized lowercase representation
      const normalizedGroups = new Map<string, string[]>();
      for (const val of uniqueVals) {
        const norm = val.toLowerCase().replace(/[^a-z0-9]/g, '');
        const list = normalizedGroups.get(norm) || [];
        list.push(val);
        normalizedGroups.set(norm, list);
      }

      // Check for variations in same group
      for (const [_, variations] of normalizedGroups.entries()) {
        if (variations.length > 1) {
          // Determine canonical value (the one with Title Case or highest frequency)
          const canonical = variations.slice().sort((a, b) => {
            const countA = rawValues.filter(v => v === a).length;
            const countB = rawValues.filter(v => v === b).length;
            return countB - countA;
          })[0];

          const nonCanonicalVariations = variations.filter(v => v !== canonical);
          const affectedRows: number[] = [];
          for (let r = 0; r < totalRows; r++) {
            const val = String(rows[r][col.name] || '').trim();
            if (nonCanonicalVariations.includes(val)) {
              affectedRows.push(r + 1);
            }
          }

          if (affectedRows.length > 0) {
            issues.push({
              id: generateId('CAT'),
              jobId,
              category: 'inconsistent_category',
              column: col.name,
              affectedRows,
              severity: 'medium',
              description: `Inconsistent casing or variant spellings detected for "${canonical}". Variations found: [${variations.map(v => `"${v}"`).join(', ')}]`,
              evidence: `Values ${nonCanonicalVariations.map(v => `"${v}"`).join(', ')} appear in rows ${affectedRows.join(', ')} instead of standard "${canonical}".`,
              suggestedAction: `Standardize all variant representations to "${canonical}".`,
              proposedValue: canonical,
              resolutionStatus: 'pending'
            });
          }
        }
      }

      // Check against known alias dictionary (e.g. HYD -> Hyderabad)
      for (const [alias, canonicalTarget] of Object.entries(DEFAULT_CATEGORY_ALIASES)) {
        const affectedRows: number[] = [];
        for (let r = 0; r < totalRows; r++) {
          const val = String(rows[r][col.name] || '').trim();
          if (val.toLowerCase() === alias && val !== canonicalTarget) {
            affectedRows.push(r + 1);
          }
        }
        if (affectedRows.length > 0) {
          // Avoid duplicate issues if already handled by normalization
          const alreadyLogged = issues.some(iss => iss.column === col.name && iss.affectedRows.some(rowNum => affectedRows.includes(rowNum)));
          if (!alreadyLogged) {
            issues.push({
              id: generateId('CAT'),
              jobId,
              category: 'inconsistent_category',
              column: col.name,
              affectedRows,
              severity: 'medium',
              description: `Abbreviation or alias "${alias.toUpperCase()}" used instead of canonical name "${canonicalTarget}".`,
              evidence: `Encountered in row(s): ${affectedRows.join(', ')}.`,
              suggestedAction: `Normalize alias "${alias}" to formal name "${canonicalTarget}".`,
              proposedValue: canonicalTarget,
              resolutionStatus: 'pending'
            });
          }
        }
      }
    }
  }

  // 4. Invalid Formats Detection (Dates, Emails, Numbers)
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  for (const col of columns) {
    const isEmailCol = /email/i.test(col.name);
    const isPureTimeCol = /^time$/i.test(col.name.trim());
    const isDateCol = !isPureTimeCol && (/date|created|updated|dob/i.test(col.name) || col.dataType === 'date' || /time/i.test(col.name));

    if (isEmailCol) {
      const invalidEmailRows: number[] = [];
      const invalidValues: string[] = [];
      for (let r = 0; r < totalRows; r++) {
        const val = rows[r][col.name];
        if (val !== null && val !== undefined && String(val).trim() !== '') {
          const str = String(val).trim();
          if (!emailRegex.test(str)) {
            invalidEmailRows.push(r + 1);
            invalidValues.push(str);
          }
        }
      }

      if (invalidEmailRows.length > 0) {
        issues.push({
          id: generateId('FMT'),
          jobId,
          category: 'invalid_format',
          column: col.name,
          affectedRows: invalidEmailRows,
          severity: 'high',
          description: `Malformed email syntax found in ${invalidEmailRows.length} ${invalidEmailRows.length === 1 ? 'row' : 'rows'}.`,
          evidence: `Invalid format samples: ${invalidValues.slice(0, 3).map(v => `"${v}"`).join(', ')}`,
          ruleViolated: 'RFC 5322 Standard Email Address Format',
          suggestedAction: 'Correct email format, query customer profile, or nullify invalid addresses.',
          proposedValue: '',
          resolutionStatus: 'pending'
        });
      }
    }

    if (isDateCol && !knownGoodColumns.includes(col.name)) {
      // --- Step 1: Sample top 5 non-empty values to detect format ---
      const sampleVals: string[] = [];
      for (let r = 0; r < totalRows && sampleVals.length < 5; r++) {
        const v = rows[r][col.name];
        const s = String(v ?? '').trim();
        if (s && !/^\d{1,2}:\d{2}(:\d{2})?(\s*(AM|PM))?$/i.test(s)) sampleVals.push(s);
      }
      if (sampleVals.length === 0) continue; // no usable dates in column

      // --- Step 2: Detect dominant separator from samples ---
      const sepScore: Record<string, number> = { '-': 0, '/': 0, '.': 0 };
      for (const s of sampleVals) {
        if (s.split('-').length === 3) sepScore['-']++;
        if (s.split('/').length === 3) sepScore['/']++;
        if (s.split('.').length === 3) sepScore['.']++;
      }
      const dominantSep = Object.entries(sepScore).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '-';

      // --- Step 3: Detect format order (YMD / DMY / MDY) from samples ---
      type FmtOrder = 'YMD' | 'DMY' | 'MDY';
      const orderScore: Record<FmtOrder, number> = { YMD: 0, DMY: 0, MDY: 0 };
      for (const s of sampleVals) {
        const parts = s.split(dominantSep);
        if (parts.length !== 3) continue;
        const [a, b, c] = parts.map(p => parseInt(p, 10));
        if (a >= 1000 && a <= 9999) { orderScore['YMD']++; }
        else if (c >= 1000 && c <= 9999) {
          if (a > 12) orderScore['DMY']++;
          else if (b > 12) orderScore['MDY']++;
          else orderScore['DMY']++;
        }
      }
      const dominantOrder: FmtOrder = (
        Object.entries(orderScore).sort((a, b) => b[1] - a[1])[0]?.[0] as FmtOrder
      ) ?? 'DMY';

      const orderLabel = dominantOrder === 'YMD'
        ? `YYYY${dominantSep}MM${dominantSep}DD`
        : dominantOrder === 'MDY'
        ? `MM${dominantSep}DD${dominantSep}YYYY`
        : `DD${dominantSep}MM${dominantSep}YYYY`;

      // Helper: normalize a single raw value to detected format+sep
      const normalizeDate = (raw: string): string | null => {
        const str = raw.trim();
        if (!str) return null;
        if (/^\d{1,2}:\d{2}(:\d{2})?(\s*(AM|PM))?$/i.test(str)) return null; // pure time
        if (/\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}[\sT]\d{1,2}:\d{2}/.test(str)) return null; // datetime
        const parts = str.split(dominantSep);
        if (parts.length !== 3) return null;
        const nums = parts.map(p => parseInt(p, 10));
        let day: number, month: number, year: number;
        if (dominantOrder === 'YMD')      { [year, month, day] = nums; }
        else if (dominantOrder === 'MDY') { [month, day, year] = nums; }
        else                              { [day, month, year] = nums; }
        if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return null;
        // Rebuild canonically in detected format + separator
        if (dominantOrder === 'YMD')
          return [String(year).padStart(4,'0'), String(month).padStart(2,'0'), String(day).padStart(2,'0')].join(dominantSep);
        if (dominantOrder === 'MDY')
          return [String(month).padStart(2,'0'), String(day).padStart(2,'0'), String(year).padStart(4,'0')].join(dominantSep);
        return [String(day).padStart(2,'0'), String(month).padStart(2,'0'), String(year).padStart(4,'0')].join(dominantSep);
      };

      // --- Step 4: Flag ALL non-empty date rows that need normalizing ---
      // Include rows that are already "valid" but not in canonical padded form,
      // AND rows that are actually malformed. Corrections engine will normalize all.
      const allDateRows: number[] = [];
      const invalidSamples: string[] = [];

      for (let r = 0; r < totalRows; r++) {
        const val = rows[r][col.name];
        if (val === null || val === undefined || String(val).trim() === '') continue;
        const str = String(val).trim();
        if (/^\d{1,2}:\d{2}(:\d{2})?(\s*(AM|PM))?$/i.test(str)) continue; // pure time
        if (/\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}[\sT]\d{1,2}:\d{2}/.test(str)) continue; // datetime

        const normalized = normalizeDate(str);
        if (normalized === null) {
          // Could not parse — definitely an issue
          allDateRows.push(r + 1);
          if (invalidSamples.length < 3) invalidSamples.push(str);
        } else if (normalized !== str) {
          // Value is parseable but not yet in canonical form (e.g. missing leading zeros)
          allDateRows.push(r + 1);
        }
        // If normalized === str, value is already perfect — skip
      }

      if (allDateRows.length > 0) {
        const sampleVal = invalidSamples.length > 0 ? invalidSamples[0] : (rows[allDateRows[0]-1]?.[col.name] ?? '');
        const fixedSample = normalizeDate(String(sampleVal)) ?? String(sampleVal);

        issues.push({
          id: generateId('FMT'),
          jobId,
          category: 'invalid_format',
          column: col.name,
          affectedRows: allDateRows,
          severity: 'medium',
          description: `${allDateRows.length} date value${allDateRows.length !== 1 ? 's' : ''} in column "${col.name}" need normalizing to detected format ${orderLabel}.`,
          evidence: `Detected format: ${orderLabel} (separator: "${dominantSep}"). Sample: "${sampleVal}" → "${fixedSample}"`,
          ruleViolated: `Detected date format: ${orderLabel}`,
          suggestedAction: `Normalize all dates to ${orderLabel} format.`,
          proposedValue: fixedSample,
          resolutionStatus: 'pending'
        });
      }
    }
  }

  // 5. Business Rules Violations (e.g. Price > 0, Quantity >= 0)
  if (settings.useBusinessRules) {
    // Built-in standard financial rules
    for (const col of columns) {
      if (col.dataType === 'number') {
        const isPrice = /price|amount|cost|revenue/i.test(col.name);
        const isQty = /quantity|qty|units|count/i.test(col.name);

        if (isPrice) {
          const negPriceRows: number[] = [];
          const negValues: number[] = [];
          for (let r = 0; r < totalRows; r++) {
            const val = rows[r][col.name];
            if (isNumeric(val) && Number(val) <= 0) {
              negPriceRows.push(r + 1);
              negValues.push(Number(val));
            }
          }
          if (negPriceRows.length > 0) {
            issues.push({
              id: generateId('RULE'),
              jobId,
              category: 'business_rule_violation',
              column: col.name,
              affectedRows: negPriceRows,
              severity: 'critical',
              description: `Negative or zero price found in ${negPriceRows.length} transaction(s). Price must be positive.`,
              evidence: `Values observed: ${negValues.slice(0, 3).join(', ')} in row(s): ${negPriceRows.join(', ')}`,
              ruleViolated: 'Business Constraint: Unit Price must be strictly greater than $0.00',
              suggestedAction: 'Take absolute value or update from product catalog pricing master.',
              proposedValue: Math.abs(negValues[0] || 0),
              resolutionStatus: 'pending'
            });
          }
        }

        if (isQty) {
          const negQtyRows: number[] = [];
          const negValues: number[] = [];
          for (let r = 0; r < totalRows; r++) {
            const val = rows[r][col.name];
            if (isNumeric(val) && Number(val) < 0) {
              negQtyRows.push(r + 1);
              negValues.push(Number(val));
            }
          }
          if (negQtyRows.length > 0) {
            issues.push({
              id: generateId('RULE'),
              jobId,
              category: 'business_rule_violation',
              column: col.name,
              affectedRows: negQtyRows,
              severity: 'high',
              description: `Negative quantity detected in ${negQtyRows.length} record(s). Unless categorized as returns, quantities must be non-negative.`,
              evidence: `Negative values: ${negValues.join(', ')} in row(s): ${negQtyRows.join(', ')}`,
              ruleViolated: 'Standard Inventory: Sale Quantity must be non-negative (>= 0)',
              suggestedAction: 'Convert negative value to positive quantity or verify return transaction status.',
              proposedValue: Math.abs(negValues[0] || 1),
              resolutionStatus: 'pending'
            });
          }
        }
      }
    }

    // Custom user rules
    for (const rule of customRules) {
      if (!rule.active) continue;
      const violatingRows: number[] = [];
      for (let r = 0; r < totalRows; r++) {
        const val = rows[r][rule.column];
        if (rule.ruleType === 'greater_than') {
          if (isNumeric(val) && Number(val) <= Number(rule.targetValue)) {
            violatingRows.push(r + 1);
          }
        } else if (rule.ruleType === 'less_than') {
          if (isNumeric(val) && Number(val) >= Number(rule.targetValue)) {
            violatingRows.push(r + 1);
          }
        } else if (rule.ruleType === 'non_empty') {
          if (val === null || val === undefined || String(val).trim() === '') {
            violatingRows.push(r + 1);
          }
        }
      }

      if (violatingRows.length > 0) {
        issues.push({
          id: generateId('RULE'),
          jobId,
          category: 'business_rule_violation',
          column: rule.column,
          affectedRows: violatingRows,
          severity: 'high',
          description: `Custom business rule "${rule.description}" violated in ${violatingRows.length} row(s).`,
          evidence: `Violations found in rows: ${violatingRows.slice(0, 5).join(', ')}`,
          ruleViolated: rule.description,
          suggestedAction: 'Correct value to comply with user-defined policy.',
          resolutionStatus: 'pending'
        });
      }
    }
  }

  // 6. Potential Outliers Detection (IQR & z-score)
  if (settings.detectOutliers) {
    const iqrMultiplier = settings.outlierSensitivity === 'high' ? 1.2 : settings.outlierSensitivity === 'low' ? 2.5 : 1.5;

    for (const col of columns) {
      if (col.dataType !== 'number') continue;
      // Do not run outlier detection on identifiers like Sale_ID, PostalCode
      if (/id|code|zip|phone/i.test(col.name)) continue;

      const numRows: { val: number; rowIdx: number }[] = [];
      for (let r = 0; r < totalRows; r++) {
        const val = rows[r][col.name];
        if (isNumeric(val)) {
          numRows.push({ val: Number(val), rowIdx: r + 1 });
        }
      }

      if (numRows.length >= 6) {
        // Sort for quartile calculation
        numRows.sort((a, b) => a.val - b.val);
        const q1Idx = Math.floor(numRows.length * 0.25);
        const q3Idx = Math.floor(numRows.length * 0.75);
        const q1 = numRows[q1Idx].val;
        const q3 = numRows[q3Idx].val;
        const iqr = q3 - q1;

        if (iqr > 0) {
          const lowerBound = q1 - (iqrMultiplier * iqr);
          const upperBound = q3 + (iqrMultiplier * iqr);

          const outlierItems = numRows.filter(item => item.val < lowerBound || item.val > upperBound);
          if (outlierItems.length > 0) {
            const outlierRows = outlierItems.map(item => item.rowIdx);
            const outlierValues = outlierItems.map(item => item.val);

            issues.push({
              id: generateId('OUT'),
              jobId,
              category: 'potential_outlier',
              column: col.name,
              affectedRows: outlierRows,
              severity: 'medium',
              description: `Statistical outlier(s) detected via Interquartile Range (IQR = ${iqr.toFixed(1)}). Normal expected range: [${lowerBound.toFixed(1)}, ${upperBound.toFixed(1)}].`,
              evidence: `Anomalous values: ${outlierValues.join(', ')} (Row #${outlierRows.join(', #')}).`,
              suggestedAction: 'Review whether this represents an input typo (e.g. extra zeros) or an exceptional wholesale transaction.',
              proposedValue: col.median ?? q3,
              resolutionStatus: 'pending'
            });
          }
        }
      }
    }
  }

  // Update columns with detected issues count
  for (const col of columns) {
    col.issuesCount = issues.filter(iss => iss.column === col.name).length;
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Exported helpers used by correctionEngine to generate per-row date corrections
// ---------------------------------------------------------------------------

/** Detect the dominant separator and order from the first 5 non-empty values of a date column */
export function detectDateColumnFormat(
  rows: Record<string, any>[],
  colName: string
): { sep: string; order: 'YMD' | 'DMY' | 'MDY' } {
  const samples: string[] = [];
  for (let r = 0; r < rows.length && samples.length < 5; r++) {
    const v = String(rows[r][colName] ?? '').trim();
    if (v && !/^\d{1,2}:\d{2}(:\d{2})?(\s*(AM|PM))?$/i.test(v)) samples.push(v);
  }

  // Detect separator
  const sepScore: Record<string, number> = { '-': 0, '/': 0, '.': 0 };
  for (const s of samples) {
    if (s.split('-').length === 3) sepScore['-']++;
    if (s.split('/').length === 3) sepScore['/']++;
    if (s.split('.').length === 3) sepScore['.']++;
  }
  const sep = Object.entries(sepScore).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '-';

  // Detect order
  const orderScore: Record<string, number> = { YMD: 0, DMY: 0, MDY: 0 };
  for (const s of samples) {
    const parts = s.split(sep);
    if (parts.length !== 3) continue;
    const [a, b, c] = parts.map(p => parseInt(p, 10));
    if (a >= 1000) { orderScore['YMD']++; }
    else if (c >= 1000) {
      if (a > 12) orderScore['DMY']++;
      else if (b > 12) orderScore['MDY']++;
      else orderScore['DMY']++;
    }
  }
  const order = (Object.entries(orderScore).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'DMY') as 'YMD' | 'DMY' | 'MDY';
  return { sep, order };
}

/**
 * Given a raw date string, the detected separator, and the detected order,
 * return a corrected date string in the SAME format + separator.
 * Returns null if the value is already valid or cannot be corrected.
 */
export function correctDateValue(
  raw: string,
  sep: string,
  order: 'YMD' | 'DMY' | 'MDY'
): string | null {
  if (!raw) return null;
  const str = raw.trim();

  // Skip pure time values
  if (/^\d{1,2}:\d{2}(:\d{2})?(\s*(AM|PM))?$/i.test(str)) return null;
  // Skip datetime strings
  if (/\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}[\sT]\d{1,2}:\d{2}/.test(str)) return null;

  const parts = str.split(sep);
  if (parts.length !== 3) return null;

  const nums = parts.map(p => parseInt(p, 10));
  let day: number, month: number, year: number;
  if (order === 'YMD')      { [year, month, day] = nums; }
  else if (order === 'MDY') { [month, day, year] = nums; }
  else                      { [day, month, year] = nums; }

  // Validate — if already valid in this format return null (no correction needed)
  if (year >= 1000 && year <= 9999 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
    return null; // already valid
  }

  // Try to fix by swapping day and month (most common error)
  const swappedDay = month;
  const swappedMonth = day;
  if (swappedMonth >= 1 && swappedMonth <= 12 && swappedDay >= 1 && swappedDay <= 31 && year >= 1000 && year <= 9999) {
    // Rebuild in detected format + separator
    if (order === 'YMD')
      return [String(year).padStart(4,'0'), String(swappedMonth).padStart(2,'0'), String(swappedDay).padStart(2,'0')].join(sep);
    if (order === 'MDY')
      return [String(swappedMonth).padStart(2,'0'), String(swappedDay).padStart(2,'0'), String(year).padStart(4,'0')].join(sep);
    return [String(swappedDay).padStart(2,'0'), String(swappedMonth).padStart(2,'0'), String(year).padStart(4,'0')].join(sep);
  }

  return null; // Cannot auto-correct
}

// ---------------------------------------------------------------------------
// Date format validator — called from UI when user specifies a date format
// ---------------------------------------------------------------------------
export type DateFormatOrder = 'DDMMYYYY' | 'MMDDYYYY' | 'YYYYMMDD' | 'YYYYDDMM' | 'DDYYYYMM' | 'MMYYYYDD';
export type DateSeparator = '-' | '/' | '.' | ' ' | '';

export interface DateFormatCheckResult {
  valid: number[];    // 1-based row numbers that are valid under the chosen format
  invalid: number[];  // 1-based row numbers that are still invalid
  samples: { row: number; original: string; parsed: string }[];
}

/**
 * Re-examines every value in a date column against a user-supplied format + separator.
 * Returns which rows are valid and which are still invalid.
 */
export function validateDatesWithFormat(
  rows: Record<string, any>[],
  colName: string,
  formatOrder: DateFormatOrder,
  separator: DateSeparator
): DateFormatCheckResult {
  const valid: number[] = [];
  const invalid: number[] = [];
  const samples: { row: number; original: string; parsed: string }[] = [];

  for (let r = 0; r < rows.length; r++) {
    const val = rows[r][colName];
    if (val === null || val === undefined || String(val).trim() === '') continue;

    const str = String(val).trim();

    // Skip pure time values
    if (/^\d{1,2}:\d{2}(:\d{2})?(\s*(AM|PM))?$/i.test(str)) {
      valid.push(r + 1);
      continue;
    }

    // Split by separator (empty means no separator — compact formats like DDMMYYYY)
    let parts: string[];
    if (separator === '') {
      // Compact: split by format length
      const lengths = formatOrder === 'DDMMYYYY' || formatOrder === 'MMDDYYYY'
        ? [2, 2, 4]
        : formatOrder === 'YYYYMMDD' || formatOrder === 'YYYYDDMM'
        ? [4, 2, 2]
        : [2, 4, 2]; // DDYYYYMM / MMYYYYDD
      let pos = 0;
      parts = lengths.map(len => { const s = str.slice(pos, pos + len); pos += len; return s; });
    } else {
      parts = str.split(separator);
    }

    if (parts.length !== 3) {
      invalid.push(r + 1);
      continue;
    }

    // Map parts to day/month/year by format order
    let day: number, month: number, year: number;
    const [a, b, c] = parts.map(p => parseInt(p, 10));

    switch (formatOrder) {
      case 'DDMMYYYY': day = a; month = b; year = c; break;
      case 'MMDDYYYY': month = a; day = b; year = c; break;
      case 'YYYYMMDD': year = a; month = b; day = c; break;
      case 'YYYYDDMM': year = a; day = b; month = c; break;
      case 'DDYYYYMM': day = a; year = b; month = c; break;
      case 'MMYYYYDD': month = a; year = b; day = c; break;
      default:         year = a; month = b; day = c;
    }

    // Validate ranges
    const isValidDate =
      year >= 1000 && year <= 9999 &&
      month >= 1 && month <= 12 &&
      day >= 1 && day <= 31;

    if (isValidDate) {
      const parsed = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      valid.push(r + 1);
      if (samples.length < 3) samples.push({ row: r + 1, original: str, parsed });
    } else {
      invalid.push(r + 1);
    }
  }

  return { valid, invalid, samples };
}
