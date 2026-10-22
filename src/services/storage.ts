import fs from 'fs';
import path from 'path';
import { AnalysisResult } from '../types/dataQuality';

const DB_FILE = path.join(process.cwd(), 'persistent_database.json');

interface DatabaseSchema {
  jobs: Record<string, AnalysisResult>;
  history: Array<{
    jobId: string;
    name: string;
    fileName: string;
    uploadedAt: string;
    rowCount: number;
    columnCount: number;
    issuesCount: number;
    correctionsApplied: number;
    scoreBefore: number;
    scoreAfter?: number;
    status: string;
  }>;
}

function loadDatabase(): DatabaseSchema {
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = fs.readFileSync(DB_FILE, 'utf-8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('[DataAId Storage] Failed to read persistent database:', err);
  }
  return { jobs: {}, history: [] };
}

function saveDatabase(db: DatabaseSchema) {
  try {
    const tmp = `${DB_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf-8');
    fs.renameSync(tmp, DB_FILE);
  } catch (err) {
    console.error('[DataAId Storage] Failed to write persistent database:', err);
  }
}

export const persistentStorage = {
  get(jobId: string): AnalysisResult | undefined {
    const db = loadDatabase();
    return db.jobs[jobId];
  },

  set(jobId: string, analysis: AnalysisResult): void {
    const db = loadDatabase();
    db.jobs[jobId] = analysis;

    // Update history summary list
    const existingIndex = db.history.findIndex(h => h.jobId === jobId);
    const summaryEntry = {
      jobId: analysis.jobId,
      name: analysis.summary.name,
      fileName: analysis.summary.fileName,
      uploadedAt: analysis.summary.uploadedAt,
      rowCount: analysis.summary.rowCount,
      columnCount: analysis.summary.columnCount,
      issuesCount: analysis.issues.length,
      correctionsApplied: analysis.appliedCorrectionsCount,
      scoreBefore: analysis.scoreBefore.overall,
      scoreAfter: analysis.scoreAfter?.overall,
      status: analysis.summary.status
    };

    if (existingIndex >= 0) {
      db.history[existingIndex] = summaryEntry;
    } else {
      db.history.unshift(summaryEntry);
    }

    saveDatabase(db);
  },

  listHistory() {
    const db = loadDatabase();
    return db.history;
  },

  count(): number {
    const db = loadDatabase();
    return Object.keys(db.jobs).length;
  }
};
