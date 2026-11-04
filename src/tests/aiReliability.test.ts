/**
 * src/tests/aiReliability.test.ts
 *
 * Deterministic test suite for AI reliability pure functions.
 * No live Gemini calls, no test framework, no new npm packages.
 * Export runTests() → { passed, failed, total, results }.
 */

import {
  normColumn,
  fuzzyMatchColumn,
  findReferencedColumns,
  isAmbiguous,
  buildDatasetContext,
  formatConversationHistory,
  buildChatPrompt,
  parseStructuredResponse,
  buildFallbackResponse,
  buildClarificationResponse,
  buildNotFoundResponse,
  computeConfidence,
  buildHeuristicStructuredAnswer,
  handleGeminiChatResponse,
  handleGeminiError,
  validateCorrection,
  routeQuestion,
  DatasetAIContext,
} from '../services/geminiService.js';

import { applySubsetSpec } from '../services/subsetEngine.js';

import {
  ColumnProfile,
  QualityIssue,
  AnalysisResult,
  ChatMessage,
} from '../types/dataQuality.js';

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

export interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg);
}

function runTest(name: string, fn: () => void, results: TestResult[]): void {
  try {
    fn();
    results.push({ name, passed: true });
  } catch (err) {
    results.push({ name, passed: false, error: err instanceof Error ? err.message : String(err) });
  }
}

// ---------------------------------------------------------------------------
// Test fixture
// ---------------------------------------------------------------------------

const makeColumn = (overrides: Partial<ColumnProfile> & { name: string; dataType: ColumnProfile['dataType'] }): ColumnProfile => ({
  nonNullCount: 100,
  missingCount: 0,
  missingPercentage: 0,
  uniqueCount: 100,
  uniquePercentage: 100,
  min: undefined,
  max: undefined,
  mean: undefined,
  median: undefined,
  stdDev: undefined,
  sampleValues: [],
  frequentValues: [],
  issuesCount: 0,
  ...overrides,
});

const fixtureColumns: ColumnProfile[] = [
  makeColumn({ name: 'id', dataType: 'number', uniqueCount: 100, nonNullCount: 100, missingCount: 0, missingPercentage: 0 }),
  makeColumn({ name: 'Revenue', dataType: 'number', missingCount: 5, missingPercentage: 5, uniqueCount: 95, mean: 1000, stdDev: 200, min: 100, max: 2000, issuesCount: 3, sampleValues: [500, 800, 1200, 1500, 900] }),
  makeColumn({ name: 'Country', dataType: 'string', missingCount: 2, missingPercentage: 2, uniqueCount: 10, issuesCount: 5, sampleValues: ['US', 'UK', 'DE'], frequentValues: [{ value: 'US', count: 50 }] }),
  makeColumn({ name: 'First Name', dataType: 'string', missingCount: 0, missingPercentage: 0, uniqueCount: 80, issuesCount: 1, sampleValues: ['Alice', 'Bob'] }),
  makeColumn({ name: 'Email_Address', dataType: 'string', missingCount: 10, missingPercentage: 10, uniqueCount: 90, issuesCount: 8, sampleValues: ['a@b.com'] }),
  makeColumn({ name: 'Status', dataType: 'string', missingCount: 1, missingPercentage: 1, uniqueCount: 3, issuesCount: 0, sampleValues: ['Active', 'Pending'] }),
];

const fixtureIssues: QualityIssue[] = [
  { id: 'I1', jobId: 'JOB-1', category: 'missing_value', column: 'Revenue', affectedRows: [2, 5], severity: 'high', description: 'Missing revenue', evidence: 'null', suggestedAction: 'Impute', proposedValue: '1000', resolutionStatus: 'pending' },
  { id: 'I2', jobId: 'JOB-1', category: 'duplicate_record', column: 'id', affectedRows: [10], severity: 'critical', description: 'Dup row', evidence: 'exact match', suggestedAction: 'DROP_ROW', proposedValue: 'DROP_ROW', resolutionStatus: 'pending' },
  { id: 'I3', jobId: 'JOB-1', category: 'inconsistent_category', column: 'Country', affectedRows: [3], severity: 'medium', description: 'Inconsistent country', evidence: 'us vs US', suggestedAction: 'Standardize', proposedValue: 'US', resolutionStatus: 'pending' },
  { id: 'I4', jobId: 'JOB-1', category: 'missing_value', column: 'Email_Address', affectedRows: [1, 4, 7], severity: 'high', description: 'Missing email', evidence: 'null', suggestedAction: 'Impute', resolutionStatus: 'pending' },
  { id: 'I5', jobId: 'JOB-1', category: 'duplicate_record', column: 'id', affectedRows: [20], severity: 'critical', description: 'Dup row 2', evidence: 'exact match', suggestedAction: 'DROP_ROW', proposedValue: 'DROP_ROW', resolutionStatus: 'pending' },
];

const fixtureRawRows: Record<string, any>[] = Array.from({ length: 100 }, (_, i) => ({
  id: i + 1,
  Revenue: i % 20 === 1 ? null : 500 + i * 10,
  Country: i % 50 === 2 ? null : 'US',
  'First Name': `Name${i}`,
  Email_Address: i % 10 === 0 ? null : `user${i}@example.com`,
  Status: 'Active',
}));

const fixtureAnalysis: AnalysisResult = {
  jobId: 'JOB-1',
  summary: { id: 'JOB-1', name: 'Sales Data', description: '', fileName: 'sales.csv', fileSize: 1000, fileType: 'csv', uploadedAt: '2024-01-01', rowCount: 100, columnCount: 6, status: 'awaiting_review' },
  columns: fixtureColumns,
  rawRows: fixtureRawRows,
  issues: fixtureIssues,
  corrections: [],
  scoreBefore: { overall: 72, completeness: 80, validity: 70, uniqueness: 90, consistency: 65, weights: { completeness: 0.3, validity: 0.3, uniqueness: 0.2, consistency: 0.2 }, unresolvedIssues: 5, explanation: '' },
  appliedCorrectionsCount: 0,
  historyLog: [],
  settings: { detectDuplicates: true, detectInconsistentCategories: true, detectOutliers: true, useBusinessRules: true, generateGenAI: false, outlierSensitivity: 'standard' },
  chatHistory: [
    { role: 'user', content: 'How many rows?' },
    { role: 'assistant', content: 'There are 100 rows.' },
    { role: 'user', content: 'What about Revenue?' },
    { role: 'assistant', content: 'Revenue has 5 missing values.' },
  ],
};

// ---------------------------------------------------------------------------
// 1. normColumn / fuzzyMatchColumn
// ---------------------------------------------------------------------------
function testColumnMatching(results: TestResult[]): void {
  runTest('normColumn: trims and lowercases', () => {
    assert(normColumn('  Revenue  ') === 'revenue', 'trim + lowercase');
  }, results);

  runTest('normColumn: collapses underscores and spaces', () => {
    assert(normColumn('first_name') === 'firstname', 'underscore removal');
    assert(normColumn('First Name') === 'firstname', 'space removal');
  }, results);

  runTest('fuzzyMatchColumn: exact match', () => {
    const match = fuzzyMatchColumn('Revenue', fixtureColumns);
    assert(match === 'Revenue', `Expected 'Revenue', got '${match}'`);
  }, results);

  runTest('fuzzyMatchColumn: case-insensitive match', () => {
    assert(fuzzyMatchColumn('revenue', fixtureColumns) === 'Revenue', 'lowercase');
    assert(fuzzyMatchColumn('REVENUE', fixtureColumns) === 'Revenue', 'uppercase');
  }, results);

  runTest('fuzzyMatchColumn: underscore normalizes to space column', () => {
    assert(fuzzyMatchColumn('first_name', fixtureColumns) === 'First Name', 'underscore → space');
  }, results);

  runTest('fuzzyMatchColumn: returns undefined for unknown column', () => {
    assert(fuzzyMatchColumn('Nonexistent', fixtureColumns) === undefined, 'unknown column');
  }, results);
}

// ---------------------------------------------------------------------------
// 2. findReferencedColumns
// ---------------------------------------------------------------------------
function testFindReferencedColumns(results: TestResult[]): void {
  runTest('findReferencedColumns: exact match in question', () => {
    const { referenced } = findReferencedColumns('Tell me about Revenue', fixtureColumns);
    assert(referenced.includes('Revenue'), 'Revenue should be referenced');
  }, results);

  runTest('findReferencedColumns: case-insensitive match', () => {
    const { referenced } = findReferencedColumns('what is the revenue total?', fixtureColumns);
    assert(referenced.includes('Revenue'), 'revenue (lowercase) should match Revenue');
  }, results);

  runTest('findReferencedColumns: quoted missing column goes to missing', () => {
    const { missing } = findReferencedColumns('Tell me about "SaleAmount"', fixtureColumns);
    assert(missing.includes('SaleAmount'), `Expected SaleAmount in missing, got: ${JSON.stringify(missing)}`);
  }, results);

  runTest('findReferencedColumns: underscored token not in columns → missing', () => {
    const { missing } = findReferencedColumns('what is Sale_Amount?', fixtureColumns);
    assert(missing.includes('Sale_Amount'), `Expected Sale_Amount in missing, got ${JSON.stringify(missing)}`);
  }, results);

  runTest('findReferencedColumns: no match and no explicit → no missing', () => {
    const { referenced, missing } = findReferencedColumns('what is the dataset about?', fixtureColumns);
    assert(referenced.length === 0, 'no referenced');
    assert(missing.length === 0, 'no missing for ordinary words');
  }, results);

  runTest('findReferencedColumns: multiple columns mentioned', () => {
    const { referenced } = findReferencedColumns('Compare Revenue and Country columns', fixtureColumns);
    assert(referenced.includes('Revenue'), 'Revenue referenced');
    assert(referenced.includes('Country'), 'Country referenced');
  }, results);

  runTest('findReferencedColumns: average of syntax', () => {
    const { missing } = findReferencedColumns('average of Sales_Amount', fixtureColumns);
    assert(missing.includes('Sales_Amount'), `Sales_Amount not in missing: ${JSON.stringify(missing)}`);
  }, results);

  runTest('findReferencedColumns: Email_Address (underscore) in question matches column', () => {
    const { referenced } = findReferencedColumns('how many missing in Email_Address?', fixtureColumns);
    assert(referenced.includes('Email_Address'), 'Email_Address should be referenced');
  }, results);

  runTest('findReferencedColumns: bare common words not flagged as missing', () => {
    const { missing } = findReferencedColumns('show me issues in the data', fixtureColumns);
    // "data" should not appear in missing as it's not a column reference
    assert(!missing.includes('data'), 'ordinary word "data" should not be in missing');
  }, results);
}

// ---------------------------------------------------------------------------
// 3. isAmbiguous
// ---------------------------------------------------------------------------
function testIsAmbiguous(results: TestResult[]): void {
  runTest('isAmbiguous: short query with no column or question word → true', () => {
    // "go now" has no question word and is short
    assert(isAmbiguous('go now', [], []) === true, '"go now" is ambiguous');
  }, results);

  runTest('isAmbiguous: short query "do it" → true', () => {
    // "do" IS in the question words list → not ambiguous
    assert(isAmbiguous('do it', [], []) === false, '"do" is a question word, so not ambiguous');
  }, results);

  runTest('isAmbiguous: query with question word → false', () => {
    assert(isAmbiguous('which columns have the most missing values?', [], []) === false, 'has question word');
  }, results);

  runTest('isAmbiguous: 12-word query → false (too long)', () => {
    const q = 'I want to know about the columns in the dataset please help me';
    assert(isAmbiguous(q, [], []) === false, '12 words should not be ambiguous');
  }, results);

  runTest('isAmbiguous: short query with referenced column → false', () => {
    assert(isAmbiguous('Revenue?', ['Revenue'], []) === false, 'has referenced column');
  }, results);

  runTest('isAmbiguous: short query with missing column → false', () => {
    assert(isAmbiguous('SaleAmount?', [], ['SaleAmount']) === false, 'has missing column');
  }, results);

  runTest('isAmbiguous: exactly 10 words with no question word → false (boundary)', () => {
    const q = 'please tell me something about this I need info now';
    const words = q.trim().split(/\s+/);
    assert(words.length === 10, `Expected 10 words, got ${words.length}`);
    assert(isAmbiguous(q, [], []) === false, '10 words is not < 10');
  }, results);

  runTest('isAmbiguous: 9 words with question word → false', () => {
    const q = 'what is the quality of my dataset right now';
    const words = q.trim().split(/\s+/);
    assert(words.length === 9, `Expected 9 words, got ${words.length}`);
    assert(isAmbiguous(q, [], []) === false, 'has question word "what"');
  }, results);

  runTest('isAmbiguous: empty string → true (length 0 < 10, no question word)', () => {
    assert(isAmbiguous('', [], []) === true, 'empty string is ambiguous');
  }, results);
}

// ---------------------------------------------------------------------------
// 4. buildDatasetContext
// ---------------------------------------------------------------------------
function testBuildDatasetContext(results: TestResult[]): void {
  runTest('buildDatasetContext: rowCount matches analysis', () => {
    const { context } = buildDatasetContext({ analysis: fixtureAnalysis, question: 'tell me everything' });
    assert(context.rowCount === 100, `Expected 100, got ${context.rowCount}`);
  }, results);

  runTest('buildDatasetContext: columnCount correct', () => {
    const { context } = buildDatasetContext({ analysis: fixtureAnalysis, question: 'describe the dataset' });
    assert(context.columnCount === 6, `Expected 6, got ${context.columnCount}`);
  }, results);

  runTest('buildDatasetContext: qualityScore from scoreBefore.overall', () => {
    const { context } = buildDatasetContext({ analysis: fixtureAnalysis, question: 'quality?' });
    assert(context.qualityScore === 72, `Expected 72, got ${context.qualityScore}`);
  }, results);

  runTest('buildDatasetContext: issueCounts includes duplicate_record', () => {
    const { context } = buildDatasetContext({ analysis: fixtureAnalysis, question: '' });
    assert(context.issueCounts['duplicate_record'] === 2, `Expected 2 duplicate_record issues, got ${context.issueCounts['duplicate_record']}`);
  }, results);

  runTest('buildDatasetContext: duplicateRecordCount matches', () => {
    const { context } = buildDatasetContext({ analysis: fixtureAnalysis, question: '' });
    assert(context.duplicateRecordCount === 2, `Expected 2, got ${context.duplicateRecordCount}`);
  }, results);

  runTest('buildDatasetContext: never includes rawRows key', () => {
    const { context } = buildDatasetContext({ analysis: fixtureAnalysis, question: 'all data' });
    assert(!('rawRows' in context), 'context must not include rawRows');
  }, results);

  runTest('buildDatasetContext: referenced column has missingCount', () => {
    const { context } = buildDatasetContext({ analysis: fixtureAnalysis, question: 'How many missing in Revenue?' });
    const col = context.focusColumns.find(c => c.name === 'Revenue');
    assert(col !== undefined, 'Revenue should be in focusColumns');
    assert(col!.missingCount === 5, `Expected 5 missing, got ${col!.missingCount}`);
  }, results);

  runTest('buildDatasetContext: general question → top 5 by issuesCount', () => {
    const { context, isGeneral } = buildDatasetContext({ analysis: fixtureAnalysis, question: 'describe everything' });
    assert(isGeneral === true, 'should be general');
    assert(context.focusColumns.length <= 5, `Expected ≤5 focus columns, got ${context.focusColumns.length}`);
  }, results);

  runTest('buildDatasetContext: 0-column edge case does not throw', () => {
    const emptyAnalysis: AnalysisResult = {
      ...fixtureAnalysis,
      columns: [],
      issues: [],
      rawRows: [],
    };
    const { context } = buildDatasetContext({ analysis: emptyAnalysis, question: 'anything' });
    assert(context.columnCount === 0, 'columnCount should be 0');
  }, results);
}

// ---------------------------------------------------------------------------
// 5. buildChatPrompt
// ---------------------------------------------------------------------------
function testBuildChatPrompt(results: TestResult[]): void {
  const { context } = buildDatasetContext({ analysis: fixtureAnalysis, question: 'What are missing values in Revenue?' });
  const prompt = buildChatPrompt({ context, question: 'What are missing values in Revenue?', history: '', missing: [], referenced: ['Revenue'] });

  runTest('buildChatPrompt: contains anti-hallucination header', () => {
    assert(prompt.includes('Use ONLY the information provided'), 'anti-hallucination sentence 1');
  }, results);

  runTest('buildChatPrompt: contains do not present assumptions sentence', () => {
    assert(prompt.includes('Do not present assumptions as verified facts'), 'anti-hallucination sentence 2');
  }, results);

  runTest('buildChatPrompt: contains do not recalculate sentence', () => {
    assert(prompt.includes('Do not recalculate or estimate them'), 'anti-hallucination sentence 3');
  }, results);

  runTest('buildChatPrompt: contains VERIFIED DATASET STATISTICS label', () => {
    assert(prompt.includes('VERIFIED DATASET STATISTICS'), 'verified stats label');
  }, results);

  runTest('buildChatPrompt: contains the user question', () => {
    assert(prompt.includes('What are missing values in Revenue?'), 'user question present');
  }, results);

  runTest('buildChatPrompt: contains not-enough-information fallback instruction', () => {
    assert(prompt.includes("I don't have enough information to answer this accurately"), 'not enough info instruction');
  }, results);

  runTest('buildChatPrompt: includes history when non-empty', () => {
    const history = 'User: How many rows?\nAssistant: 100.';
    const promptWithHistory = buildChatPrompt({ context, question: 'follow up', history, missing: [], referenced: [] });
    assert(promptWithHistory.includes('PREVIOUS CONVERSATION'), 'history section present');
    assert(promptWithHistory.includes('How many rows?'), 'history content present');
  }, results);

  runTest('buildChatPrompt: omits history section when empty', () => {
    const promptNoHistory = buildChatPrompt({ context, question: 'hello', history: '', missing: [], referenced: [] });
    assert(!promptNoHistory.includes('PREVIOUS CONVERSATION'), 'no history section when empty');
  }, results);
}

// ---------------------------------------------------------------------------
// 6. parseStructuredResponse
// ---------------------------------------------------------------------------
function testParseStructuredResponse(results: TestResult[]): void {
  runTest('parseStructuredResponse: valid JSON → ok:true', () => {
    const json = JSON.stringify({ answer: 'Test answer', evidence: ['Fact1'], recommendation: null, confidence: 'High', confidenceReason: 'Good', warnings: [] });
    const result = parseStructuredResponse(json);
    assert(result.ok === true, 'should parse successfully');
    if (result.ok) {
      assert(result.value.answer === 'Test answer', 'answer matches');
      assert(result.value.evidence.length === 1, 'evidence length');
      assert(result.value.confidence === 'High', 'confidence preserved');
    }
  }, results);

  runTest('parseStructuredResponse: missing answer → ok:false', () => {
    const json = JSON.stringify({ evidence: ['Fact1'], confidence: 'High', confidenceReason: '', warnings: [] });
    const result = parseStructuredResponse(json);
    assert(result.ok === false, 'should fail without answer');
  }, results);

  runTest('parseStructuredResponse: missing evidence → ok:false', () => {
    const json = JSON.stringify({ answer: 'Test', confidence: 'High', confidenceReason: '', warnings: [] });
    const result = parseStructuredResponse(json);
    assert(result.ok === false, 'should fail without evidence');
  }, results);

  runTest('parseStructuredResponse: invalid confidence → coerced to Medium', () => {
    const json = JSON.stringify({ answer: 'Test', evidence: [], confidence: 'Very High', confidenceReason: '', warnings: [] });
    const result = parseStructuredResponse(json);
    assert(result.ok === true, 'should still parse');
    if (result.ok) assert(result.value.confidence === 'Medium', 'invalid confidence coerced to Medium');
  }, results);

  runTest('parseStructuredResponse: null/empty input → ok:false', () => {
    const result = parseStructuredResponse('');
    assert(result.ok === false, 'empty string should fail');
  }, results);

  runTest('parseStructuredResponse: strips markdown fences', () => {
    const json = '```json\n' + JSON.stringify({ answer: 'Fenced', evidence: ['E1'], confidence: 'Low', confidenceReason: '', warnings: [] }) + '\n```';
    const result = parseStructuredResponse(json);
    assert(result.ok === true, 'should parse markdown-fenced JSON');
    if (result.ok) assert(result.value.answer === 'Fenced', 'answer from fenced JSON');
  }, results);

  runTest('parseStructuredResponse: handles prose-wrapped JSON', () => {
    const inner = JSON.stringify({ answer: 'Wrapped', evidence: [], confidence: 'Medium', confidenceReason: '', warnings: [] });
    const prose = `Here is the analysis: ${inner} Hope that helps!`;
    const result = parseStructuredResponse(prose);
    assert(result.ok === true, 'should extract JSON from prose');
    if (result.ok) assert(result.value.answer === 'Wrapped', 'answer from prose-wrapped JSON');
  }, results);

  runTest('parseStructuredResponse: non-JSON string → ok:false', () => {
    const result = parseStructuredResponse('This is just a plain text response without any JSON structure at all.');
    assert(result.ok === false, 'plain text should fail');
  }, results);

  runTest('parseStructuredResponse: extra fields are ignored gracefully', () => {
    const json = JSON.stringify({ answer: 'Test', evidence: ['F1'], confidence: 'Low', confidenceReason: 'x', warnings: [], extraField: 'ignored', nested: { a: 1 } });
    const result = parseStructuredResponse(json);
    assert(result.ok === true, 'extra fields should not fail parsing');
  }, results);

  runTest('parseStructuredResponse: coerces evidence items to strings', () => {
    const json = JSON.stringify({ answer: 'Test', evidence: [42, true, { text: 'obj' }], confidence: 'Medium', confidenceReason: '', warnings: [] });
    const result = parseStructuredResponse(json);
    assert(result.ok === true, 'should parse');
    if (result.ok) {
      result.value.evidence.forEach(e => assert(typeof e === 'string', `evidence item should be string: ${e}`));
    }
  }, results);
}

// ---------------------------------------------------------------------------
// 7. computeConfidence
// ---------------------------------------------------------------------------
function testComputeConfidence(results: TestResult[]): void {
  runTest('computeConfidence: High when referenced + evidence + no warnings', () => {
    const { level } = computeConfidence({ referenced: ['Revenue'], missing: [], evidence: ['Revenue has 5 missing'], warnings: [], usedFallback: false, validationFailed: false, isGeneral: false });
    assert(level === 'High', `Expected High, got ${level}`);
  }, results);

  runTest('computeConfidence: Low when usedFallback', () => {
    const { level } = computeConfidence({ referenced: ['Revenue'], missing: [], evidence: ['E1'], warnings: [], usedFallback: true, validationFailed: false, isGeneral: false });
    assert(level === 'Low', `Expected Low, got ${level}`);
  }, results);

  runTest('computeConfidence: Low when validationFailed', () => {
    const { level } = computeConfidence({ referenced: [], missing: [], evidence: [], warnings: [], usedFallback: false, validationFailed: true, isGeneral: false });
    assert(level === 'Low', `Expected Low, got ${level}`);
  }, results);

  runTest('computeConfidence: Low when missing columns', () => {
    const { level } = computeConfidence({ referenced: [], missing: ['SaleAmount'], evidence: [], warnings: [], usedFallback: false, validationFailed: false, isGeneral: false });
    assert(level === 'Low', `Expected Low, got ${level}`);
  }, results);

  runTest('computeConfidence: Low takes precedence over High', () => {
    const { level } = computeConfidence({ referenced: ['Revenue'], missing: ['SaleAmount'], evidence: ['E1'], warnings: [], usedFallback: false, validationFailed: false, isGeneral: false });
    assert(level === 'Low', 'missing column should give Low even with referenced + evidence');
  }, results);

  runTest('computeConfidence: Medium for general question', () => {
    const { level } = computeConfidence({ referenced: [], missing: [], evidence: [], warnings: [], usedFallback: false, validationFailed: false, isGeneral: true });
    assert(level === 'Medium', `Expected Medium, got ${level}`);
  }, results);

  runTest('computeConfidence: Medium when warnings contain inference', () => {
    const { level } = computeConfidence({ referenced: ['Revenue'], missing: [], evidence: ['E1'], warnings: ['This is inferred from available data'], usedFallback: false, validationFailed: false, isGeneral: false });
    assert(level === 'Medium', `Expected Medium due to inference warning, got ${level}`);
  }, results);

  runTest('computeConfidence: Medium when evidence is empty but no fallback', () => {
    const { level } = computeConfidence({ referenced: ['Revenue'], missing: [], evidence: [], warnings: [], usedFallback: false, validationFailed: false, isGeneral: false });
    assert(level === 'Medium', `Expected Medium (thin evidence), got ${level}`);
  }, results);
}

// ---------------------------------------------------------------------------
// 8. buildFallbackResponse
// ---------------------------------------------------------------------------
function testBuildFallbackResponse(results: TestResult[]): void {
  runTest('buildFallbackResponse: confidence is always Low', () => {
    const fb = buildFallbackResponse({ answer: 'Test error', reason: 'Parse failed' });
    assert(fb.confidence === 'Low', `Expected Low, got ${fb.confidence}`);
  }, results);

  runTest('buildFallbackResponse: answer is set correctly', () => {
    const fb = buildFallbackResponse({ answer: 'My fallback answer', reason: 'Some reason' });
    assert(fb.answer === 'My fallback answer', 'answer should match');
  }, results);

  runTest('buildFallbackResponse: reason is in warnings', () => {
    const fb = buildFallbackResponse({ answer: 'x', reason: 'The reason' });
    assert(fb.warnings.includes('The reason'), 'reason should appear in warnings');
  }, results);

  runTest('buildFallbackResponse: evidence is always empty', () => {
    const fb = buildFallbackResponse({ answer: 'x', reason: 'y' });
    assert(fb.evidence.length === 0, 'evidence should be empty');
  }, results);

  runTest('buildFallbackResponse: recommendation is null', () => {
    const fb = buildFallbackResponse({ answer: 'x', reason: 'y' });
    assert(fb.recommendation === null, 'recommendation should be null');
  }, results);
}

// ---------------------------------------------------------------------------
// 9. buildNotFoundResponse / buildClarificationResponse
// ---------------------------------------------------------------------------
function testResponseBuilders(results: TestResult[]): void {
  runTest('buildNotFoundResponse: answer names the missing column', () => {
    const resp = buildNotFoundResponse(['SaleAmount'], fixtureColumns.map(c => c.name));
    assert(resp.answer.includes('SaleAmount'), 'should mention missing column');
  }, results);

  runTest('buildNotFoundResponse: lists available columns (up to 10)', () => {
    const cols = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'];
    const resp = buildNotFoundResponse(['X'], cols);
    // First 10 should be listed
    for (const c of cols.slice(0, 10)) {
      assert(resp.answer.includes(c), `${c} should be in the answer`);
    }
  }, results);

  runTest('buildNotFoundResponse: confidence is Low', () => {
    const resp = buildNotFoundResponse(['X'], ['A', 'B']);
    assert(resp.confidence === 'Low', `Expected Low, got ${resp.confidence}`);
  }, results);

  runTest('buildClarificationResponse: clarificationNeeded is true', () => {
    const resp = buildClarificationResponse('show it', ['Revenue', 'Country']);
    assert(resp.clarificationNeeded === true, 'clarificationNeeded should be true');
  }, results);

  runTest('buildClarificationResponse: confidence is Low', () => {
    const resp = buildClarificationResponse('do it', []);
    assert(resp.confidence === 'Low', `Expected Low, got ${resp.confidence}`);
  }, results);
}

// ---------------------------------------------------------------------------
// 10. handleGeminiChatResponse
// ---------------------------------------------------------------------------
function testHandleGeminiChatResponse(results: TestResult[]): void {
  const { context } = buildDatasetContext({ analysis: fixtureAnalysis, question: 'Revenue missing values?' });

  runTest('handleGeminiChatResponse: valid JSON → returns structured response', () => {
    const raw = JSON.stringify({ answer: 'Revenue has 5 missing values.', evidence: ['5 missing out of 100'], recommendation: 'Impute', confidence: 'High', confidenceReason: 'Direct', warnings: [] });
    const resp = handleGeminiChatResponse({ raw, context, referenced: ['Revenue'], missing: [], isGeneral: false, provider: 'Gemini' });
    assert(resp.answer === 'Revenue has 5 missing values.', 'answer preserved');
    assert(resp.provider === 'Gemini', 'provider set');
    // Confidence is backend-overridden
    assert(resp.confidence !== undefined, 'confidence present');
  }, results);

  runTest('handleGeminiChatResponse: malformed JSON → Low fallback', () => {
    const resp = handleGeminiChatResponse({ raw: 'not valid json at all!!!', context, referenced: [], missing: [], isGeneral: false, provider: 'Gemini' });
    assert(resp.confidence === 'Low', `Expected Low, got ${resp.confidence}`);
    assert(resp.evidence.length === 0, 'fallback has empty evidence');
  }, results);

  runTest('handleGeminiChatResponse: empty raw → Low fallback', () => {
    const resp = handleGeminiChatResponse({ raw: '', context, referenced: [], missing: [], isGeneral: true, provider: 'Gemini' });
    assert(resp.confidence === 'Low', `Expected Low, got ${resp.confidence}`);
  }, results);

  runTest('handleGeminiChatResponse: backend confidence overrides Gemini value', () => {
    // Gemini says High but referenced.length = 0 → should be Medium (general, no fallback)
    const raw = JSON.stringify({ answer: 'Something', evidence: ['A fact'], recommendation: null, confidence: 'High', confidenceReason: 'gemini said so', warnings: [] });
    const resp = handleGeminiChatResponse({ raw, context, referenced: [], missing: [], isGeneral: true, provider: 'Gemini' });
    // referenced=0, isGeneral=true, no missing, has evidence → Medium
    assert(resp.confidence === 'Medium', `Expected Medium (backend computed), got ${resp.confidence}`);
  }, results);
}

// ---------------------------------------------------------------------------
// 11. handleGeminiError
// ---------------------------------------------------------------------------
function testHandleGeminiError(results: TestResult[]): void {
  runTest('handleGeminiError: 429 error → rate-limit message', () => {
    const err = { status: 429, message: 'Rate limited' };
    const resp = handleGeminiError(err);
    assert(resp.answer.includes('rate-limited'), `Expected rate-limit message, got: ${resp.answer}`);
    assert(resp.confidence === 'Low', 'confidence should be Low');
  }, results);

  runTest('handleGeminiError: generic error → friendly message', () => {
    const err = new Error('Connection timeout');
    const resp = handleGeminiError(err);
    assert(resp.answer.includes('temporarily unavailable'), `Expected unavailable message, got: ${resp.answer}`);
    assert(resp.confidence === 'Low', 'confidence should be Low');
  }, results);

  runTest('handleGeminiError: rate-limit detected via message text', () => {
    const err = new Error('You have exceeded your quota limit (429)');
    const resp = handleGeminiError(err);
    assert(resp.answer.includes('rate-limited'), `Expected rate-limit message via message text, got: ${resp.answer}`);
  }, results);
}

// ---------------------------------------------------------------------------
// 12. validateCorrection
// ---------------------------------------------------------------------------
function testValidateCorrection(results: TestResult[]): void {
  const revenueCol = fixtureColumns.find(c => c.name === 'Revenue')!;
  const idCol = fixtureColumns.find(c => c.name === 'id')!;
  const issue = fixtureIssues[0]; // missing Revenue, affectedRows: [2, 5]

  runTest('validateCorrection: valid numeric value for number column → passed', () => {
    const result = validateCorrection({ proposedValue: '1200', column: revenueCol, rawRows: fixtureRawRows, issue });
    assert(result.dataTypeValid === true, 'dataTypeValid should be true');
    assert(result.passed === true, 'passed should be true for valid numeric');
  }, results);

  runTest('validateCorrection: non-numeric for number column → dataTypeValid false', () => {
    const result = validateCorrection({ proposedValue: 'N/A', column: revenueCol, rawRows: fixtureRawRows, issue });
    assert(result.dataTypeValid === false, 'should fail type check');
    assert(result.passed === false, 'passed should be false');
  }, results);

  runTest('validateCorrection: value outside 2 stdDev → rangeWarning', () => {
    // mean=1000, stdDev=200, so >1400 or <600 triggers warning. Use 5000.
    const result = validateCorrection({ proposedValue: '5000', column: revenueCol, rawRows: fixtureRawRows, issue });
    assert(result.rangeWarning !== null, 'should have range warning');
    assert(result.dataTypeValid === true, 'type still valid');
  }, results);

  runTest('validateCorrection: value within 2 stdDev → no rangeWarning', () => {
    const result = validateCorrection({ proposedValue: '1100', column: revenueCol, rawRows: fixtureRawRows, issue });
    assert(result.rangeWarning === null, 'no range warning for value within 2 stdDev');
  }, results);

  runTest('validateCorrection: DROP_ROW → passed with no value checks', () => {
    const result = validateCorrection({ proposedValue: 'DROP_ROW', column: revenueCol, rawRows: fixtureRawRows, issue });
    assert(result.passed === true, 'DROP_ROW should pass');
    assert(result.dataTypeValid === true, 'DROP_ROW skips type check');
    assert(result.rangeWarning === null, 'DROP_ROW has no range warning');
    assert(result.duplicateWarning === null, 'DROP_ROW has no duplicate warning');
  }, results);

  runTest('validateCorrection: column not found → passed false', () => {
    const result = validateCorrection({ proposedValue: '100', column: undefined, rawRows: fixtureRawRows, issue });
    assert(result.passed === false, 'should fail when column not found');
    assert(result.dataTypeValid === false, 'dataTypeValid false when column not found');
  }, results);

  runTest('validateCorrection: rangeWarning does not make passed=false', () => {
    // Out of range but type valid and not a key column duplicate
    const result = validateCorrection({ proposedValue: '5000', column: revenueCol, rawRows: fixtureRawRows, issue });
    // rangeWarning is advisory; passed = dataTypeValid && !duplicateWarning
    assert(result.passed === true, 'range warning should not fail passed');
  }, results);
}

// ---------------------------------------------------------------------------
// 13. routeQuestion (pure orchestrator prefix)
// ---------------------------------------------------------------------------
function testRouteQuestion(results: TestResult[]): void {
  runTest('routeQuestion: missing column → not-found response', () => {
    // Use underscore pattern to trigger explicit missing column detection
    const resp = routeQuestion(fixtureAnalysis, 'Tell me about Sales_Amount column');
    assert(resp.confidence === 'Low', 'should be Low confidence');
    assert(resp.answer.includes('not found') || resp.missingColumns !== undefined, `Expected not-found answer, got: ${resp.answer}`);
  }, results);

  runTest('routeQuestion: ambiguous short question → clarification', () => {
    // "go now" — short, no column, no question word
    const resp = routeQuestion(fixtureAnalysis, 'go now');
    assert(resp.clarificationNeeded === true, `should ask for clarification, got: ${resp.answer}`);
    assert(resp.confidence === 'Low', 'clarification should be Low confidence');
  }, results);

  runTest('routeQuestion: valid question → heuristic answer (not a fallback)', () => {
    const resp = routeQuestion(fixtureAnalysis, 'What are the missing values in Revenue?');
    assert(resp.answer.length > 0, 'answer should not be empty');
    // Not a not-found response and not clarification
    assert(resp.clarificationNeeded !== true, 'should not request clarification');
    assert(!resp.answer.toLowerCase().includes('not found'), 'should not be not-found response');
  }, results);

  runTest('routeQuestion: general question → heuristic with dataset fact', () => {
    const resp = routeQuestion(fixtureAnalysis, 'Can you describe the dataset structure and quality?');
    assert(resp.answer.includes('Sales Data') || resp.answer.includes('100'), 'should include dataset-specific fact');
  }, results);
}

// ---------------------------------------------------------------------------
// 14. formatConversationHistory
// ---------------------------------------------------------------------------
function testFormatConversationHistory(results: TestResult[]): void {
  runTest('formatConversationHistory: last 3 pairs from history', () => {
    const history = formatConversationHistory(fixtureAnalysis.chatHistory!, 3);
    assert(history.includes('How many rows?'), 'should include earlier message');
    assert(history.includes('Revenue'), 'should include Revenue message');
  }, results);

  runTest('formatConversationHistory: empty history → empty string', () => {
    const history = formatConversationHistory([], 3);
    assert(history === '', 'empty history should return empty string');
  }, results);

  runTest('formatConversationHistory: user messages prefixed with User:', () => {
    const msgs: ChatMessage[] = [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'world' }];
    const history = formatConversationHistory(msgs, 3);
    assert(history.includes('User: hello'), 'user prefix');
    assert(history.includes('Assistant: world'), 'assistant prefix');
  }, results);
}

// ---------------------------------------------------------------------------
// 15. buildHeuristicStructuredAnswer
// ---------------------------------------------------------------------------
function testBuildHeuristicStructuredAnswer(results: TestResult[]): void {
  runTest('buildHeuristicStructuredAnswer: includes dataset-specific fact in evidence', () => {
    const { context } = buildDatasetContext({ analysis: fixtureAnalysis, question: 'anything general' });
    const resp = buildHeuristicStructuredAnswer({ context, referenced: [], missing: [], isGeneral: true });
    assert(resp.evidence.length > 0, 'evidence should not be empty');
    assert(resp.evidence[0].length > 0, 'evidence fact should not be empty string');
  }, results);

  runTest('buildHeuristicStructuredAnswer: referenced column fact includes missingCount', () => {
    const { context } = buildDatasetContext({ analysis: fixtureAnalysis, question: 'Revenue?' });
    const resp = buildHeuristicStructuredAnswer({ context, referenced: ['Revenue'], missing: [], isGeneral: false });
    assert(resp.answer.includes('Revenue') || resp.evidence.some(e => e.includes('Revenue')), 'should mention Revenue');
  }, results);

  runTest('buildHeuristicStructuredAnswer: has heuristic warning', () => {
    const { context } = buildDatasetContext({ analysis: fixtureAnalysis, question: 'anything' });
    const resp = buildHeuristicStructuredAnswer({ context, referenced: [], missing: [], isGeneral: true });
    assert(resp.warnings.some(w => w.toLowerCase().includes('heuristic') || w.includes('GEMINI_API_KEY')), 'should have heuristic warning');
  }, results);
}


// ---------------------------------------------------------------------------
// 16. Deterministic row/column subset selection
// ---------------------------------------------------------------------------
function testDatasetSubsetSelection(results: TestResult[]): void {
  const columns: ColumnProfile[] = [
    makeColumn({ name: 'Name', dataType: 'string' }),
    makeColumn({ name: 'Age', dataType: 'number' }),
    makeColumn({ name: 'City', dataType: 'string' })
  ];
  const rows = [
    { Name: 'Asha', Age: 22, City: 'Hyderabad' },
    { Name: 'Ravi', Age: 29, City: 'Pune' },
    { Name: 'Mina', Age: 31, City: 'Hyderabad' }
  ];

  runTest('subset: exact 1-based row number returns requested record', () => {
    const result = applySubsetSpec(rows, { rowNumbers: [2] }, columns);
    assert(result.rows.length === 1, 'expected exactly one row');
    assert(result.rows[0].Name === 'Ravi', 'row 2 should be Ravi');
  }, results);

  runTest('subset: selected columns are projected in requested order', () => {
    const result = applySubsetSpec(rows, { includeColumns: ['City', 'Name'] }, columns);
    assert(result.columns.join(',') === 'City,Name', 'column order should be retained');
    assert(Object.keys(result.rows[0]).join(',') === 'City,Name', 'only requested columns should be returned');
  }, results);

  runTest('subset: row number and column selection work together', () => {
    const result = applySubsetSpec(rows, { rowNumbers: [3], includeColumns: ['Name', 'Age'] }, columns);
    assert(result.rows.length === 1 && result.rows[0].Name === 'Mina', 'expected row 3');
    assert(Object.keys(result.rows[0]).join(',') === 'Name,Age', 'expected only requested columns');
  }, results);

  runTest('subset: row selection and filter conditions are both applied', () => {
    const result = applySubsetSpec(rows, {
      rowNumbers: [1, 2, 3],
      conditions: [{ column: 'City', operator: 'equals', value: 'Hyderabad' }]
    }, columns);
    assert(result.rows.length === 2, 'expected two Hyderabad rows');
  }, results);
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------
export function runTests(): { passed: number; failed: number; total: number; results: TestResult[] } {
  const results: TestResult[] = [];

  testColumnMatching(results);
  testFindReferencedColumns(results);
  testIsAmbiguous(results);
  testBuildDatasetContext(results);
  testBuildChatPrompt(results);
  testParseStructuredResponse(results);
  testComputeConfidence(results);
  testBuildFallbackResponse(results);
  testResponseBuilders(results);
  testHandleGeminiChatResponse(results);
  testHandleGeminiError(results);
  testValidateCorrection(results);
  testRouteQuestion(results);
  testFormatConversationHistory(results);
  testBuildHeuristicStructuredAnswer(results);
  testDatasetSubsetSelection(results);

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;

  return { passed, failed, total: results.length, results };
}
