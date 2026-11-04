import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { AnalysisResult } from '../types/dataQuality';

const DB_FILE = path.join(process.cwd(), 'persistent_database.json');
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false }, max: 5 })
  : null;
let schemaReady: Promise<void> | null = null;

interface DatabaseSchema {
  jobs: Record<string, AnalysisResult>;
  history: Array<{ jobId: string; name: string; fileName: string; uploadedAt: string; rowCount: number; columnCount: number; issuesCount: number; correctionsApplied: number; scoreBefore: number; scoreAfter?: number; status: string }>;
}

function loadDatabase(): DatabaseSchema {
  try {
    if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
  } catch (error) { console.error('[DataAId] Local storage read failed:', error); }
  return { jobs: {}, history: [] };
}
function saveDatabase(db: DatabaseSchema) {
  const temp = `${DB_FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(db), 'utf-8');
  fs.renameSync(temp, DB_FILE);
}
async function ensureSchema() {
  if (!pool) return;
  if (!schemaReady) schemaReady = pool.query(`
    CREATE TABLE IF NOT EXISTS dataaid_jobs (
      job_id TEXT PRIMARY KEY,
      analysis JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS dataaid_jobs_updated_at_idx ON dataaid_jobs(updated_at DESC);
  `).then(() => undefined);
  await schemaReady;
}
function historyEntry(a: AnalysisResult) {
  return { jobId: a.jobId, name: a.summary.name, fileName: a.summary.fileName, uploadedAt: a.summary.uploadedAt, rowCount: a.summary.rowCount, columnCount: a.summary.columnCount, issuesCount: a.issues.length, correctionsApplied: a.appliedCorrectionsCount, scoreBefore: a.scoreBefore.overall, scoreAfter: a.scoreAfter?.overall, status: a.summary.status };
}

export const persistentStorage = {
  async get(jobId: string): Promise<AnalysisResult | undefined> {
    if (pool) {
      await ensureSchema();
      const result = await pool.query('SELECT analysis FROM dataaid_jobs WHERE job_id = $1', [jobId]);
      return result.rows[0]?.analysis as AnalysisResult | undefined;
    }
    return loadDatabase().jobs[jobId];
  },
  async set(jobId: string, analysis: AnalysisResult): Promise<void> {
    if (pool) {
      await ensureSchema();
      await pool.query(`INSERT INTO dataaid_jobs(job_id, analysis, updated_at) VALUES($1, $2::jsonb, NOW())
        ON CONFLICT(job_id) DO UPDATE SET analysis = EXCLUDED.analysis, updated_at = NOW()`, [jobId, JSON.stringify(analysis)]);
      return;
    }
    const db = loadDatabase();
    db.jobs[jobId] = analysis;
    const entry = historyEntry(analysis);
    const index = db.history.findIndex(item => item.jobId === jobId);
    if (index >= 0) db.history[index] = entry; else db.history.unshift(entry);
    saveDatabase(db);
  },
  async listHistory() {
    if (pool) {
      await ensureSchema();
      const result = await pool.query(`SELECT analysis FROM dataaid_jobs ORDER BY updated_at DESC LIMIT 100`);
      return result.rows.map(row => historyEntry(row.analysis as AnalysisResult));
    }
    return loadDatabase().history;
  },
  async count(): Promise<number> {
    if (pool) {
      await ensureSchema();
      const result = await pool.query('SELECT COUNT(*)::int AS count FROM dataaid_jobs');
      return result.rows[0].count;
    }
    return Object.keys(loadDatabase().jobs).length;
  },
  provider(): 'postgresql' | 'local-json' { return pool ? 'postgresql' : 'local-json'; },
  async health(): Promise<boolean> {
    if (!pool) return true;
    try { await pool.query('SELECT 1'); return true; } catch { return false; }
  }
};
