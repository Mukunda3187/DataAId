export type IssueSeverity = 'critical' | 'high' | 'medium' | 'low' | 'informational';

export type IssueCategory = 
  | 'missing_value' 
  | 'duplicate_record' 
  | 'inconsistent_category' 
  | 'invalid_format' 
  | 'business_rule_violation' 
  | 'potential_outlier';

export interface ColumnProfile {
  name: string;
  dataType: 'string' | 'number' | 'date' | 'boolean';
  nonNullCount: number;
  missingCount: number;
  missingPercentage: number;
  uniqueCount: number;
  uniquePercentage: number;
  min?: number | string;
  max?: number | string;
  mean?: number;
  median?: number;
  stdDev?: number;
  sampleValues: any[];
  frequentValues: { value: string; count: number }[];
  issuesCount: number;
}

export interface QualityWeights {
  completeness: number;
  validity: number;
  uniqueness: number;
  consistency: number;
}

export interface QualityScore {
  overall: number; // 0-100
  completeness: number;
  validity: number;
  uniqueness: number;
  consistency: number;
  weights: QualityWeights;
  unresolvedIssues: number;
  explanation: string;
}

export interface AIExplanation {
  simpleExplanation: string;
  whyItMatters: string;
  potentialCause: string;
  recommendedAction: string;
  proposedCorrection?: string;
  assumptionsAndLimitations: string;
  requiresHumanReview: boolean;
  provider: 'Gemini 3.8-Flash' | 'Rule-based Expert';
}

export interface CommitLogEntry {
  hash: string;
  timestamp: string;
  action: string;
  author?: string;
  details: string;
  type?: 'upload' | 'detection' | 'approval' | 'apply' | 'rejection' | 'edit' | 'ai_analysis' | 'export';
  stats?: {
    totalErrors?: number;
    errorsByCategory?: Record<string, number>;
    appliedCount?: number;
    rowsAffected?: number;
    scoreBefore?: number;
    scoreAfter?: number;
    scoreDelta?: number;
  };
  initialErrorsSummary?: {
    category: IssueCategory;
    title: string;
    count: number;
    columns: string[];
    severity: IssueSeverity;
  }[];
}

export interface QualityIssue {
  id: string;
  jobId: string;
  category: IssueCategory;
  column: string;
  affectedRows: number[]; // 1-indexed for display
  severity: IssueSeverity;
  description: string;
  evidence: string;
  ruleViolated?: string;
  suggestedAction: string;
  proposedValue?: any;
  resolutionStatus: 'pending' | 'approved' | 'rejected' | 'applied';
  aiExplanation?: AIExplanation;
  alternateSuggestions?: string[];
}

export interface CorrectionItem {
  id: string;
  issueId: string;
  rowRef: number; // 1-indexed row number
  column: string;
  originalValue: any;
  proposedValue: any;
  editedValue?: any;
  reason: string;
  source: 'genai' | 'heuristic_rule' | 'user_manual';
  status: 'pending' | 'approved' | 'rejected' | 'applied';
  timestamp?: string;
  alternateSuggestions?: string[];
}

export interface DatasetSummary {
  id: string;
  name: string;
  description: string;
  fileName: string;
  fileSize: number;
  fileType: 'csv' | 'xlsx';
  uploadedAt: string;
  rowCount: number;
  columnCount: number;
  status: 'uploaded' | 'validating' | 'analyzing' | 'awaiting_review' | 'applying_corrections' | 'completed' | 'failed';
}

export interface BusinessRule {
  id: string;
  column: string;
  ruleType: 'greater_than' | 'less_than' | 'non_empty' | 'regex' | 'custom_enum';
  targetValue: string | number;
  description: string;
  active: boolean;
}

export interface AnalysisSettings {
  detectDuplicates: boolean;
  detectInconsistentCategories: boolean;
  detectOutliers: boolean;
  useBusinessRules: boolean;
  generateGenAI: boolean;
  outlierSensitivity: 'standard' | 'high' | 'low'; // IQR 1.5 vs 1.2 vs 2.0
}

export interface AnalysisResult {
  jobId: string;
  summary: DatasetSummary;
  columns: ColumnProfile[];
  rawRows: Record<string, any>[];
  cleanedRows?: Record<string, any>[];
  issues: QualityIssue[];
  corrections: CorrectionItem[];
  scoreBefore: QualityScore;
  scoreAfter?: QualityScore;
  appliedCorrectionsCount: number;
  historyLog: CommitLogEntry[];
  settings: AnalysisSettings;
  knownGoodColumns?: string[];
}
