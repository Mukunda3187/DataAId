/**
 * src/tests/datamate.test.ts
 *
 * Deterministic test suite for the Datamate analytics engine.
 * No live Gemini calls, no test framework, no new npm packages.
 * Export runTests() → { passed, failed, total, results }.
 *
 * Run via: GET /api/test/datamate
 */

import {
  parseQuestionIntent,
  computeDatasetAnalytics,
  classifyDatamateIntent_testable,
} from '../services/analyticsEngine.js';

import {
  isKeyInCooldown,
  setKeyCooldownForTest,
  clearKeyCooldownsForTest,
} from '../services/geminiService.js';

import { ColumnProfile, AnalysisResult } from '../types/dataQuality.js';

// ---------------------------------------------------------------------------
// Test infrastructure (mirrors aiReliability.test.ts pattern)
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
// Fixtures
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

const testColumns: ColumnProfile[] = [
  makeColumn({ name: 'CustomerID', dataType: 'number' }),
  makeColumn({ name: 'Name', dataType: 'string' }),
  makeColumn({ name: 'City', dataType: 'string' }),
  makeColumn({ name: 'Salary', dataType: 'number', mean: 56000 }),
  makeColumn({ name: 'Age', dataType: 'number' }),
  makeColumn({ name: 'Product', dataType: 'string' }),
  makeColumn({ name: 'Sales', dataType: 'number' }),
];

const testColumnNames = testColumns.map(c => c.name);

const mockRows: Record<string, any>[] = [
  { CustomerID: 1, Name: 'Alice', City: 'Hyderabad', Salary: 50000, Age: 28, Product: 'Widget', Sales: 100 },
  { CustomerID: 2, Name: 'Bob',   City: 'Bangalore', Salary: 60000, Age: 35, Product: 'Gadget', Sales: 200 },
  { CustomerID: 3, Name: 'Carol', City: 'Hyderabad', Salary: 55000, Age: 30, Product: 'Widget', Sales: 150 },
  { CustomerID: 4, Name: 'Dave',  City: 'Mumbai',    Salary: 70000, Age: 40, Product: 'Gadget', Sales: 300 },
  { CustomerID: 5, Name: 'Eve',   City: 'Hyderabad', Salary: 45000, Age: 25, Product: 'Donut',  Sales: 50  },
];

// Build a minimal AnalysisResult for computeDatasetAnalytics
const mockAnalysis: AnalysisResult = {
  jobId: 'TEST-1',
  summary: {
    id: 'TEST-1', name: 'Test Dataset', description: '', fileName: 'test.csv',
    fileSize: 1000, fileType: 'csv', uploadedAt: '2024-01-01',
    rowCount: 5, columnCount: 7, status: 'awaiting_review',
  },
  columns: testColumns.map(c => ({
    ...c,
    nonNullCount: 5,
    uniqueCount: 5,
    missingCount: 0,
    missingPercentage: 0,
  })),
  rawRows: mockRows,
  issues: [],
  corrections: [],
  scoreBefore: {
    overall: 90, completeness: 95, validity: 90, uniqueness: 90, consistency: 90,
    weights: { completeness: 0.3, validity: 0.3, uniqueness: 0.2, consistency: 0.2 },
    unresolvedIssues: 0, explanation: '',
  },
  appliedCorrectionsCount: 0,
  historyLog: [],
  settings: {
    detectDuplicates: true, detectInconsistentCategories: true, detectOutliers: true,
    useBusinessRules: true, generateGenAI: false, outlierSensitivity: 'standard',
  },
};

// ---------------------------------------------------------------------------
// Group 1 — parseQuestionIntent (10 tests)
// ---------------------------------------------------------------------------
function testParseQuestionIntent(results: TestResult[]): void {
  runTest('parseQuestionIntent: average salary → aggregation avg', () => {
    const intent = parseQuestionIntent('what is the average salary', testColumnNames);
    assert(intent.type === 'aggregation', `Expected aggregation, got ${intent.type}`);
    assert(intent.aggregation === 'avg', `Expected avg, got ${intent.aggregation}`);
  }, results);

  runTest('parseQuestionIntent: highest salary → aggregation max', () => {
    const intent = parseQuestionIntent('highest salary', testColumnNames);
    assert(intent.type === 'aggregation', `Expected aggregation, got ${intent.type}`);
    assert(intent.aggregation === 'max', `Expected max, got ${intent.aggregation}`);
  }, results);

  runTest('parseQuestionIntent: show row 15 → row_lookup rowNumber 15', () => {
    const intent = parseQuestionIntent('show row 15', testColumnNames);
    assert(intent.type === 'row_lookup', `Expected row_lookup, got ${intent.type}`);
    assert(intent.rowNumber === 15, `Expected 15, got ${intent.rowNumber}`);
  }, results);

  runTest('parseQuestionIntent: top 5 products → top_n topN 5', () => {
    const intent = parseQuestionIntent('top 5 products', testColumnNames);
    assert(intent.type === 'top_n', `Expected top_n, got ${intent.type}`);
    assert(intent.topN === 5, `Expected 5, got ${intent.topN}`);
  }, results);

  runTest('parseQuestionIntent: which city has most customers → distribution', () => {
    const intent = parseQuestionIntent('which city has most customers', testColumnNames);
    assert(intent.type === 'distribution', `Expected distribution, got ${intent.type}`);
  }, results);

  runTest('parseQuestionIntent: missing values → column_info', () => {
    const intent = parseQuestionIntent('missing values', testColumnNames);
    assert(intent.type === 'column_info', `Expected column_info, got ${intent.type}`);
  }, results);

  runTest('parseQuestionIntent: sum of revenue/sales → aggregation sum', () => {
    const intent = parseQuestionIntent('sum of sales', testColumnNames);
    assert(intent.type === 'aggregation', `Expected aggregation, got ${intent.type}`);
    assert(intent.aggregation === 'sum', `Expected sum, got ${intent.aggregation}`);
  }, results);

  runTest('parseQuestionIntent: minimum age → aggregation min', () => {
    const intent = parseQuestionIntent('minimum age', testColumnNames);
    assert(intent.type === 'aggregation', `Expected aggregation, got ${intent.type}`);
    assert(intent.aggregation === 'min', `Expected min, got ${intent.aggregation}`);
  }, results);

  runTest('parseQuestionIntent: explain salary column → column_info', () => {
    const intent = parseQuestionIntent('explain salary column', testColumnNames);
    assert(intent.type === 'column_info', `Expected column_info, got ${intent.type}`);
  }, results);

  runTest('parseQuestionIntent: how many rows → aggregation count', () => {
    const intent = parseQuestionIntent('how many rows', testColumnNames);
    assert(intent.type === 'aggregation', `Expected aggregation, got ${intent.type}`);
    assert(intent.aggregation === 'count', `Expected count, got ${intent.aggregation}`);
  }, results);
}

// ---------------------------------------------------------------------------
// Group 2 — computeDatasetAnalytics (8 tests)
// ---------------------------------------------------------------------------
function testComputeDatasetAnalytics(results: TestResult[]): void {
  runTest('computeDatasetAnalytics: avg Salary ≈ 56000', () => {
    const intent = parseQuestionIntent('average salary', testColumnNames);
    const facts = computeDatasetAnalytics(mockAnalysis, intent);
    assert(facts.length > 0, 'Expected at least one fact');
    const val = Number(facts[0].value);
    // (50000+60000+55000+70000+45000)/5 = 56000
    assert(Math.abs(val - 56000) < 1, `Expected ~56000, got ${val}`);
  }, results);

  runTest('computeDatasetAnalytics: max Salary = 70000', () => {
    const intent = parseQuestionIntent('highest salary', testColumnNames);
    const facts = computeDatasetAnalytics(mockAnalysis, intent);
    assert(facts.length > 0, 'Expected at least one fact');
    assert(Number(facts[0].value) === 70000, `Expected 70000, got ${facts[0].value}`);
  }, results);

  runTest('computeDatasetAnalytics: min Age = 25', () => {
    const intent = parseQuestionIntent('minimum age', testColumnNames);
    const facts = computeDatasetAnalytics(mockAnalysis, intent);
    assert(facts.length > 0, 'Expected at least one fact');
    assert(Number(facts[0].value) === 25, `Expected 25, got ${facts[0].value}`);
  }, results);

  runTest('computeDatasetAnalytics: row_lookup rowNumber 1 returns Alice', () => {
    const intent = parseQuestionIntent('show row 1', testColumnNames);
    const facts = computeDatasetAnalytics(mockAnalysis, intent);
    assert(facts.length > 0, 'Expected at least one fact');
    const row = JSON.parse(String(facts[0].value));
    assert(row.Name === 'Alice', `Expected Alice, got ${row.Name}`);
  }, results);

  runTest('computeDatasetAnalytics: distribution City has Hyderabad:3', () => {
    const intent: import('../services/analyticsEngine.js').ParsedIntent = {
      type: 'distribution',
      groupBy: 'City',
    };
    const facts = computeDatasetAnalytics(mockAnalysis, intent);
    assert(facts.length > 0, 'Expected at least one fact');
    const val = String(facts[0].value);
    assert(val.includes('Hyderabad: 3') || val.includes('Hyderabad:3'), `Expected Hyderabad count 3, got: ${val}`);
  }, results);

  runTest('computeDatasetAnalytics: sum Sales = 800', () => {
    const intent = parseQuestionIntent('sum of sales', testColumnNames);
    const facts = computeDatasetAnalytics(mockAnalysis, intent);
    assert(facts.length > 0, 'Expected at least one fact');
    assert(Number(facts[0].value) === 800, `Expected 800, got ${facts[0].value}`);
  }, results);

  runTest('computeDatasetAnalytics: count (no filter) = 5', () => {
    const intent: import('../services/analyticsEngine.js').ParsedIntent = {
      type: 'aggregation',
      aggregation: 'count',
    };
    const facts = computeDatasetAnalytics(mockAnalysis, intent);
    assert(facts.length > 0, 'Expected at least one fact');
    assert(Number(facts[0].value) === 5, `Expected 5, got ${facts[0].value}`);
  }, results);

  runTest('computeDatasetAnalytics: top_n 2 by Salary → first row salary 70000', () => {
    const intent: import('../services/analyticsEngine.js').ParsedIntent = {
      type: 'top_n',
      topN: 2,
      columns: ['Salary'],
      sortDir: 'desc',
    };
    const facts = computeDatasetAnalytics(mockAnalysis, intent);
    assert(facts.length > 0, 'Expected at least one fact');
    const rows = JSON.parse(String(facts[0].value));
    assert(Array.isArray(rows) && rows.length === 2, `Expected 2 rows, got ${rows.length}`);
    assert(Number(rows[0].Salary) === 70000, `Expected first row Salary=70000, got ${rows[0].Salary}`);
  }, results);
}

// ---------------------------------------------------------------------------
// Group 3 — classifyDatamateIntent_testable (10 tests)
// ---------------------------------------------------------------------------
function testClassifyDatamateIntent(results: TestResult[]): void {
  const cols = testColumns.map(c => ({ name: c.name }));

  runTest('classify: create dataset from Hyderabad → build', () => {
    const r = classifyDatamateIntent_testable('Create a dataset containing only customers from Hyderabad', cols);
    assert(r === 'build', `Expected build, got ${r}`);
  }, results);

  runTest('classify: average age question → question', () => {
    const r = classifyDatamateIntent_testable('What is the average age of customers?', cols);
    assert(r === 'question', `Expected question, got ${r}`);
  }, results);

  runTest('classify: give dataset with columns → build', () => {
    const r = classifyDatamateIntent_testable('Give me a dataset with Name, Age, Salary columns', cols);
    assert(r === 'build', `Expected build, got ${r}`);
  }, results);

  runTest('classify: which columns have missing values → question', () => {
    const r = classifyDatamateIntent_testable('Which columns have missing values?', cols);
    assert(r === 'question', `Expected question, got ${r}`);
  }, results);

  runTest('classify: show rows where City = Hyderabad → build', () => {
    const r = classifyDatamateIntent_testable('Show rows where City = Hyderabad', cols);
    assert(r === 'build', `Expected build, got ${r}`);
  }, results);

  runTest('classify: explain Salary column → question', () => {
    const r = classifyDatamateIntent_testable('Explain the Salary column', cols);
    assert(r === 'question', `Expected question, got ${r}`);
  }, results);

  runTest('classify: top 100 products → build', () => {
    const r = classifyDatamateIntent_testable('Top 100 highest-selling products', cols);
    assert(r === 'build', `Expected build, got ${r}`);
  }, results);

  runTest('classify: overall quality question → question', () => {
    const r = classifyDatamateIntent_testable('What is the overall quality of this dataset?', cols);
    assert(r === 'question', `Expected question, got ${r}`);
  }, results);

  runTest('classify: remove duplicates and create clean dataset → build', () => {
    const r = classifyDatamateIntent_testable('Remove duplicate records and create a clean dataset', cols);
    assert(r === 'build', `Expected build, got ${r}`);
  }, results);

  runTest('classify: how many rows → question', () => {
    const r = classifyDatamateIntent_testable('How many rows are in this dataset?', cols);
    assert(r === 'question', `Expected question, got ${r}`);
  }, results);
}

// ---------------------------------------------------------------------------
// Group 4 — Key rotation cooldown logic (4 tests)
// ---------------------------------------------------------------------------
function testKeyCooldownLogic(results: TestResult[]): void {
  // Clear any state left from prior tests
  clearKeyCooldownsForTest();

  runTest('cooldown: key with future cooldown → isKeyInCooldown true', () => {
    const key = 'test-key-1';
    const future = Date.now() + 60000;
    setKeyCooldownForTest(key, future);
    assert(isKeyInCooldown(key, Date.now()) === true, 'Expected key to be in cooldown');
  }, results);

  runTest('cooldown: key with past cooldown → isKeyInCooldown false', () => {
    const key = 'test-key-2';
    const past = Date.now() - 1;
    setKeyCooldownForTest(key, past);
    assert(isKeyInCooldown(key, Date.now()) === false, 'Expected expired cooldown to be false');
  }, results);

  runTest('cooldown: cleared key → isKeyInCooldown false', () => {
    const key = 'test-key-3';
    setKeyCooldownForTest(key, Date.now() + 60000);
    clearKeyCooldownsForTest();
    assert(isKeyInCooldown(key, Date.now()) === false, 'Expected cleared cooldown to be false');
  }, results);

  runTest('cooldown: future now past cooldown → isKeyInCooldown false', () => {
    const key = 'test-key-4';
    const until = Date.now() + 5000;
    setKeyCooldownForTest(key, until);
    // "now" is after the cooldown expires
    assert(isKeyInCooldown(key, until + 1) === false, 'Expected false when now is past cooldown');
  }, results);

  // Clean up after tests
  clearKeyCooldownsForTest();
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------
export function runTests(): { passed: number; failed: number; total: number; results: TestResult[] } {
  const results: TestResult[] = [];

  testParseQuestionIntent(results);
  testComputeDatasetAnalytics(results);
  testClassifyDatamateIntent(results);
  testKeyCooldownLogic(results);

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;

  return { passed, failed, total: results.length, results };
}
