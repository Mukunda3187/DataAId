import { ColumnProfile } from '../types/dataQuality';

export function isNumeric(val: any): boolean {
  if (val === null || val === undefined || val === '') return false;
  const num = Number(val);
  return !isNaN(num) && isFinite(num);
}

export function isDateString(val: any): boolean {
  if (typeof val !== 'string' || val.trim() === '') return false;
  // Check standard patterns: YYYY-MM-DD, DD/MM/YYYY, etc.
  const dateRegex = /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$|^\d{1,2}[-/.]\d{1,2}[-/.]\d{4}$/;
  if (!dateRegex.test(val)) return false;
  const parsed = Date.parse(val);
  return !isNaN(parsed);
}

export function profileDataset(rows: Record<string, any>[]): ColumnProfile[] {
  if (!rows || rows.length === 0) return [];

  const totalRows = rows.length;
  const headers = Object.keys(rows[0]);

  return headers.map(colName => {
    let nonNullCount = 0;
    let missingCount = 0;
    const valueMap = new Map<string, number>();
    const numericValues: number[] = [];
    const sampleValuesSet = new Set<any>();

    let numericCandidateCount = 0;
    let dateCandidateCount = 0;
    let booleanCandidateCount = 0;

    for (let i = 0; i < totalRows; i++) {
      const val = rows[i][colName];
      const isMissing = val === null || val === undefined || (typeof val === 'string' && val.trim() === '');

      if (isMissing) {
        missingCount++;
      } else {
        nonNullCount++;
        const strVal = String(val).trim();
        valueMap.set(strVal, (valueMap.get(strVal) || 0) + 1);

        if (sampleValuesSet.size < 5) {
          sampleValuesSet.add(val);
        }

        if (isNumeric(val)) {
          numericCandidateCount++;
          numericValues.push(Number(val));
        } else if (isDateString(strVal)) {
          dateCandidateCount++;
        } else if (strVal.toLowerCase() === 'true' || strVal.toLowerCase() === 'false') {
          booleanCandidateCount++;
        }
      }
    }

    // Determine dominant data type
    let dataType: 'string' | 'number' | 'date' | 'boolean' = 'string';
    if (nonNullCount > 0) {
      if (numericCandidateCount / nonNullCount > 0.6) {
        dataType = 'number';
      } else if (dateCandidateCount / nonNullCount > 0.6) {
        dataType = 'date';
      } else if (booleanCandidateCount / nonNullCount > 0.6) {
        dataType = 'boolean';
      }
    }

    const uniqueCount = valueMap.size;
    const missingPercentage = totalRows > 0 ? (missingCount / totalRows) * 100 : 0;
    const uniquePercentage = nonNullCount > 0 ? (uniqueCount / nonNullCount) * 100 : 0;

    // Top frequent values
    const frequentValues = Array.from(valueMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([value, count]) => ({ value, count }));

    // Numeric stats
    let min: number | undefined;
    let max: number | undefined;
    let mean: number | undefined;
    let median: number | undefined;
    let stdDev: number | undefined;

    if (dataType === 'number' && numericValues.length > 0) {
      numericValues.sort((a, b) => a - b);
      min = numericValues[0];
      max = numericValues[numericValues.length - 1];
      const sum = numericValues.reduce((acc, curr) => acc + curr, 0);
      mean = Number((sum / numericValues.length).toFixed(2));

      const mid = Math.floor(numericValues.length / 2);
      median = numericValues.length % 2 === 0
        ? Number(((numericValues[mid - 1] + numericValues[mid]) / 2).toFixed(2))
        : Number(numericValues[mid].toFixed(2));

      const meanVal = mean ?? 0;
      const variance = numericValues.reduce((acc, curr) => acc + Math.pow(curr - meanVal, 2), 0) / numericValues.length;
      stdDev = Number(Math.sqrt(variance).toFixed(2));
    }

    return {
      name: colName,
      dataType,
      nonNullCount,
      missingCount,
      missingPercentage: Number(missingPercentage.toFixed(1)),
      uniqueCount,
      uniquePercentage: Number(uniquePercentage.toFixed(1)),
      min,
      max,
      mean,
      median,
      stdDev,
      sampleValues: Array.from(sampleValuesSet),
      frequentValues,
      issuesCount: 0
    };
  });
}
