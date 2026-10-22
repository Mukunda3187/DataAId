import { QualityScore, QualityWeights, QualityIssue, ColumnProfile } from '../types/dataQuality';

export const DEFAULT_WEIGHTS: QualityWeights = {
  completeness: 0.30,
  validity: 0.30,
  uniqueness: 0.20,
  consistency: 0.20,
};

export function calculateQualityScore(
  totalRows: number,
  columns: ColumnProfile[],
  issues: QualityIssue[],
  customWeights: QualityWeights = DEFAULT_WEIGHTS
): QualityScore {
  if (totalRows === 0 || columns.length === 0) {
    return {
      overall: 0,
      completeness: 0,
      validity: 0,
      uniqueness: 0,
      consistency: 0,
      weights: customWeights,
      unresolvedIssues: 0,
      explanation: 'No rows available for evaluation.'
    };
  }

  const totalCells = totalRows * columns.length;

  // Filter out rejected issues - when an issue is rejected by user, it is no longer considered an issue
  const activeIssues = issues.filter(iss => iss.resolutionStatus !== 'rejected');

  // 1. Completeness Dimension: Measures absence of null, empty, or whitespace values
  const activeMissingCols = new Set(
    activeIssues.filter(iss => iss.category === 'missing_value').map(iss => iss.column)
  );
  const totalMissingValues = columns.reduce((acc, col) => {
    return activeMissingCols.has(col.name) ? acc + col.missingCount : acc;
  }, 0);
  const completeness = Math.max(0, Math.min(100, ((totalCells - totalMissingValues) / totalCells) * 100));

  // 2. Uniqueness Dimension: Measures absence of exact duplicate rows
  const duplicateIssues = activeIssues.filter(iss => iss.category === 'duplicate_record');
  const duplicateRowsCount = duplicateIssues.reduce((acc, iss) => acc + iss.affectedRows.length, 0);
  const uniqueness = Math.max(0, Math.min(100, ((totalRows - duplicateRowsCount) / totalRows) * 100));

  // 3. Validity Dimension: Measures conformance to data formats, business constraints, and numeric ranges
  const validityIssues = activeIssues.filter(iss => iss.category === 'invalid_format' || iss.category === 'business_rule_violation');
  const invalidCellsCount = validityIssues.reduce((acc, iss) => acc + iss.affectedRows.length, 0);
  const validity = Math.max(0, Math.min(100, ((totalCells - invalidCellsCount) / totalCells) * 100));

  // 4. Consistency Dimension: Measures uniformity of categorical naming, abbreviations, and formatting
  const consistencyIssues = activeIssues.filter(iss => iss.category === 'inconsistent_category' || iss.category === 'potential_outlier');
  const inconsistentCellsCount = consistencyIssues.reduce((acc, iss) => acc + iss.affectedRows.length, 0);
  const consistency = Math.max(0, Math.min(100, ((totalCells - inconsistentCellsCount) / totalCells) * 100));

  // Ensure weights sum to 1
  const weightSum = customWeights.completeness + customWeights.validity + customWeights.uniqueness + customWeights.consistency;
  const wComp = customWeights.completeness / (weightSum || 1);
  const wVal = customWeights.validity / (weightSum || 1);
  const wUniq = customWeights.uniqueness / (weightSum || 1);
  const wCons = customWeights.consistency / (weightSum || 1);

  const overall = (completeness * wComp) + (validity * wVal) + (uniqueness * wUniq) + (consistency * wCons);
  const unresolvedIssues = activeIssues.filter(i => i.resolutionStatus === 'pending').length;

  const explanation = `Score evaluated across ${totalCells.toLocaleString()} data cells. Completeness (${completeness.toFixed(1)}% × ${(wComp*100).toFixed(0)}%) + Validity (${validity.toFixed(1)}% × ${(wVal*100).toFixed(0)}%) + Uniqueness (${uniqueness.toFixed(1)}% × ${(wUniq*100).toFixed(0)}%) + Consistency (${consistency.toFixed(1)}% × ${(wCons*100).toFixed(0)}%). Total unresolved issues: ${unresolvedIssues}.`;

  return {
    overall: Number(overall.toFixed(1)),
    completeness: Number(completeness.toFixed(1)),
    validity: Number(validity.toFixed(1)),
    uniqueness: Number(uniqueness.toFixed(1)),
    consistency: Number(consistency.toFixed(1)),
    weights: {
      completeness: Number(wComp.toFixed(2)),
      validity: Number(wVal.toFixed(2)),
      uniqueness: Number(wUniq.toFixed(2)),
      consistency: Number(wCons.toFixed(2))
    },
    unresolvedIssues,
    explanation
  };
}
