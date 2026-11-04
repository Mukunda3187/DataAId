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
  provider: 'Gemini' | 'Rule-based Expert';
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
  storageProvider?: string;
  storageObjectKey?: string;
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

export type SubsetOperator =
  | 'equals' | 'notEquals' | 'contains'
  | 'gt' | 'gte' | 'lt' | 'lte'
  | 'in' | 'isNull' | 'notNull';

export interface SubsetCondition {
  column: string;      // real column name (validated against analysis.columns)
  operator: SubsetOperator;
  value: string | number | null;  // null only valid for isNull/notNull
}

export interface SubsetSpec {
  rowNumbers?: number[];           // 1-indexed dataset row numbers (header excluded)
  includeColumns?: string[];      // ordered, validated output columns
  conditions?: SubsetCondition[]; // AND-joined by default; OR when conditionLogic='OR'
  conditionLogic?: 'AND' | 'OR';  // default AND; use OR for "rows with any missing value"
  limit?: number;
  distinct?: boolean;
  sort?: { column: string; direction: 'asc' | 'desc' }[];
}

// Persisted on analysis.subsets for re-download. Deliberately excludes the row
// set: the CSV is regenerated from rawRows + spec, never stored wholesale.
export interface StoredSubset {
  subsetId: string;
  instruction: string;
  spec: SubsetSpec;
  columns: string[];     // validated output column names
  rowCount: number;      // full filtered count
  previewRows: Record<string, any>[];  // capped at 100, lets the card re-render from history with no extra fetch
  provider: string;
  warnings?: string[];
}

// Live result returned to the client and carried on the assistant chat message
// so the UI can render the preview without a second fetch.
export interface SubsetResult {
  subsetId: string;
  instruction: string;
  spec: SubsetSpec;
  columns: string[];
  rowCount: number;     // full filtered count
  previewRows: Record<string, any>[];  // capped at 100
  provider: string;
  warnings?: string[];
}

export type ConfidenceLevel = 'High' | 'Medium' | 'Low';

// Validated, backend-owned structured Q&A response. `content` on ChatMessage
// mirrors `answer` for backward compatibility; this object carries the rest.
export interface StructuredAIResponse {
  answer: string;                    // plain-language, context-only answer (or fallback text)
  evidence: string[];                // facts drawn from the dataset context
  recommendation: string | null;     // actionable suggestion, or null
  confidence: ConfidenceLevel;        // backend-computed (Gemini's own value is discarded)
  confidenceReason: string;          // why this confidence level
  warnings: string[];                // caveats / limitations / inferences
  clarificationNeeded?: boolean;      // true when the question was too ambiguous to answer
  provider?: string;                 // 'Gemini' | 'Profile-based fallback' | 'Heuristic (Demo Mode)'
  referencedColumns?: string[];      // real columns the question matched (for UI + tests)
  missingColumns?: string[];         // columns named but not found (for UI + tests)
  structured?: true;                 // marker so callers can distinguish structured responses
}

// Backend validation of a proposed correction value.
export interface CorrectionValidation {
  column: string;
  originalValue: string;             // current value in the first affected row
  proposedValue: string;             // the suggested value (or 'DROP_ROW')
  dataTypeValid: boolean;            // false when a number column gets a non-numeric value
  rangeWarning: string | null;       // non-null when |proposed - mean| > 2*stdDev (numeric only)
  duplicateWarning: string | null;   // non-null when applying the value would dup a key column
  passed: boolean;                   // dataTypeValid && duplicateWarning === null
  notes: string[];                   // human-readable findings
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  provider?: string;  // optional provider label on assistant answers (demo vs Gemini)
  subset?: SubsetResult;  // present only on assistant messages that render a built subset
  structured?: StructuredAIResponse;  // present on assistant Q&A messages (new)
  computedFacts?: { label: string; result: any; type: string };  // computed analytics for follow-up context
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
  // Cached AI-generated dataset understanding (JSON envelope of { understanding, provider }).
  // Present once the report has been generated; a new upload omits it, forcing regeneration.
  datasetUnderstanding?: string;
  // Persisted Datamate conversation history; survives browser reload until a new upload.
  chatHistory?: ChatMessage[];
  // Persisted built subset specs for re-download (spec only, never the rows).
  subsets?: StoredSubset[];
}
