"""
Persistent SQLite Database Storage for DataAId
Provides persistent storage for analysis sessions, raw data, issues, corrections, and audit history.
"""
import sqlite3
import json
import os
from typing import Dict, Any, List, Optional
from datetime import datetime

DB_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "dataaid.db")

def get_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_connection()
    cursor = conn.cursor()

    # 1. Jobs Table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS jobs (
        job_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        file_name TEXT,
        file_size INTEGER,
        file_type TEXT,
        row_count INTEGER,
        column_count INTEGER,
        status TEXT,
        applied_corrections_count INTEGER DEFAULT 0,
        score_before_overall REAL,
        score_after_overall REAL,
        created_at TEXT,
        updated_at TEXT
    )
    """)

    # 2. Datasets Table (Preserves raw rows and cleaned rows safely)
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS datasets (
        job_id TEXT PRIMARY KEY,
        raw_rows_json TEXT NOT NULL,
        cleaned_rows_json TEXT,
        columns_json TEXT NOT NULL,
        score_before_json TEXT NOT NULL,
        score_after_json TEXT,
        settings_json TEXT NOT NULL,
        FOREIGN KEY (job_id) REFERENCES jobs (job_id) ON DELETE CASCADE
    )
    """)

    # 3. Issues Table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS issues (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        category TEXT NOT NULL,
        column_name TEXT NOT NULL,
        severity TEXT NOT NULL,
        description TEXT NOT NULL,
        evidence TEXT,
        suggested_action TEXT,
        proposed_value TEXT,
        resolution_status TEXT NOT NULL,
        affected_rows_json TEXT NOT NULL,
        ai_explanation_json TEXT,
        FOREIGN KEY (job_id) REFERENCES jobs (job_id) ON DELETE CASCADE
    )
    """)

    # 4. Corrections Table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS corrections (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        issue_id TEXT NOT NULL,
        row_ref INTEGER NOT NULL,
        column_name TEXT NOT NULL,
        original_value TEXT,
        proposed_value TEXT,
        edited_value TEXT,
        reason TEXT,
        source TEXT,
        status TEXT NOT NULL,
        FOREIGN KEY (job_id) REFERENCES jobs (job_id) ON DELETE CASCADE
    )
    """)

    # 5. Audit History Log Table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS history_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        action TEXT NOT NULL,
        details TEXT NOT NULL,
        FOREIGN KEY (job_id) REFERENCES jobs (job_id) ON DELETE CASCADE
    )
    """)

    conn.commit()
    conn.close()

# Auto-initialize tables on module import
init_db()

def save_analysis(analysis: Dict[str, Any]):
    conn = get_connection()
    cursor = conn.cursor()
    now = datetime.utcnow().isoformat()

    job_id = analysis["jobId"]
    summary = analysis["summary"]
    score_before = analysis.get("scoreBefore", {})
    score_after = analysis.get("scoreAfter")

    # Save Job Summary
    cursor.execute("""
    INSERT OR REPLACE INTO jobs (
        job_id, name, description, file_name, file_size, file_type,
        row_count, column_count, status, applied_corrections_count,
        score_before_overall, score_after_overall, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        job_id,
        summary.get("name", "Untitled Dataset"),
        summary.get("description", ""),
        summary.get("fileName", ""),
        summary.get("fileSize", 0),
        summary.get("fileType", "csv"),
        summary.get("rowCount", len(analysis.get("rawRows", []))),
        summary.get("columnCount", len(analysis.get("columns", []))),
        summary.get("status", "awaiting_review"),
        analysis.get("appliedCorrectionsCount", 0),
        score_before.get("overall", 0.0),
        score_after.get("overall") if score_after else None,
        summary.get("uploadedAt", now),
        now
    ))

    # Save Dataset Blobs (JSON encoded)
    cursor.execute("""
    INSERT OR REPLACE INTO datasets (
        job_id, raw_rows_json, cleaned_rows_json, columns_json,
        score_before_json, score_after_json, settings_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    """, (
        job_id,
        json.dumps(analysis.get("rawRows", [])),
        json.dumps(analysis.get("cleanedRows")) if analysis.get("cleanedRows") is not None else None,
        json.dumps(analysis.get("columns", [])),
        json.dumps(score_before),
        json.dumps(score_after) if score_after else None,
        json.dumps(analysis.get("settings", {}))
    ))

    # Delete existing issues & corrections for this job to replace cleanly
    cursor.execute("DELETE FROM issues WHERE job_id = ?", (job_id,))
    cursor.execute("DELETE FROM corrections WHERE job_id = ?", (job_id,))

    # Insert Issues
    for iss in analysis.get("issues", []):
        cursor.execute("""
        INSERT INTO issues (
            id, job_id, category, column_name, severity, description,
            evidence, suggested_action, proposed_value, resolution_status,
            affected_rows_json, ai_explanation_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            iss["id"],
            job_id,
            iss.get("category", "quality_issue"),
            iss.get("column", ""),
            iss.get("severity", "medium"),
            iss.get("description", ""),
            iss.get("evidence", ""),
            iss.get("suggestedAction", ""),
            str(iss.get("proposedValue", "")),
            iss.get("resolutionStatus", "pending"),
            json.dumps(iss.get("affectedRows", [])),
            json.dumps(iss.get("aiExplanation")) if iss.get("aiExplanation") else None
        ))

    # Insert Corrections
    for c in analysis.get("corrections", []):
        cursor.execute("""
        INSERT INTO corrections (
            id, job_id, issue_id, row_ref, column_name, original_value,
            proposed_value, edited_value, reason, source, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            c["id"],
            job_id,
            c.get("issueId", ""),
            c.get("rowRef", 1),
            c.get("column", ""),
            str(c.get("originalValue", "")),
            str(c.get("proposedValue", "")),
            str(c.get("editedValue")) if c.get("editedValue") is not None else None,
            c.get("reason", ""),
            c.get("source", "heuristic_rule"),
            c.get("status", "pending")
        ))

    # Insert History Logs if any
    for log in analysis.get("historyLog", []):
        cursor.execute("""
        INSERT INTO history_log (job_id, timestamp, action, details)
        VALUES (?, ?, ?, ?)
        """, (job_id, log.get("timestamp", now), log.get("action", ""), log.get("details", "")))

    conn.commit()
    conn.close()

def get_analysis(job_id: str) -> Optional[Dict[str, Any]]:
    conn = get_connection()
    cursor = conn.cursor()

    cursor.execute("SELECT * FROM jobs WHERE job_id = ?", (job_id,))
    job_row = cursor.fetchone()
    if not job_row:
        conn.close()
        return None

    cursor.execute("SELECT * FROM datasets WHERE job_id = ?", (job_id,))
    dataset_row = cursor.fetchone()
    if not dataset_row:
        conn.close()
        return None

    # Retrieve issues
    cursor.execute("SELECT * FROM issues WHERE job_id = ?", (job_id,))
    issues_rows = cursor.fetchall()
    issues = []
    for r in issues_rows:
        issues.append({
            "id": r["id"],
            "jobId": r["job_id"],
            "category": r["category"],
            "column": r["column_name"],
            "severity": r["severity"],
            "description": r["description"],
            "evidence": r["evidence"],
            "suggestedAction": r["suggested_action"],
            "proposedValue": r["proposed_value"],
            "resolutionStatus": r["resolution_status"],
            "affectedRows": json.loads(r["affected_rows_json"]),
            "aiExplanation": json.loads(r["ai_explanation_json"]) if r["ai_explanation_json"] else None
        })

    # Retrieve corrections
    cursor.execute("SELECT * FROM corrections WHERE job_id = ?", (job_id,))
    cor_rows = cursor.fetchall()
    corrections = []
    for r in cor_rows:
        corrections.append({
            "id": r["id"],
            "issueId": r["issue_id"],
            "rowRef": r["row_ref"],
            "column": r["column_name"],
            "originalValue": r["original_value"],
            "proposedValue": r["proposed_value"],
            "editedValue": r["edited_value"],
            "reason": r["reason"],
            "source": r["source"],
            "status": r["status"]
        })

    # Retrieve history
    cursor.execute("SELECT * FROM history_log WHERE job_id = ? ORDER BY id ASC", (job_id,))
    log_rows = cursor.fetchall()
    history_log = [{"timestamp": r["timestamp"], "action": r["action"], "details": r["details"]} for r in log_rows]

    conn.close()

    return {
        "jobId": job_row["job_id"],
        "summary": {
            "id": job_row["job_id"],
            "name": job_row["name"],
            "description": job_row["description"],
            "fileName": job_row["file_name"],
            "fileSize": job_row["file_size"],
            "fileType": job_row["file_type"],
            "uploadedAt": job_row["created_at"],
            "rowCount": job_row["row_count"],
            "columnCount": job_row["column_count"],
            "status": job_row["status"]
        },
        "columns": json.loads(dataset_row["columns_json"]),
        "rawRows": json.loads(dataset_row["raw_rows_json"]),
        "cleanedRows": json.loads(dataset_row["cleaned_rows_json"]) if dataset_row["cleaned_rows_json"] else None,
        "issues": issues,
        "corrections": corrections,
        "scoreBefore": json.loads(dataset_row["score_before_json"]),
        "scoreAfter": json.loads(dataset_row["score_after_json"]) if dataset_row["score_after_json"] else None,
        "appliedCorrectionsCount": job_row["applied_corrections_count"],
        "historyLog": history_log,
        "settings": json.loads(dataset_row["settings_json"])
    }

def list_history() -> List[Dict[str, Any]]:
    conn = get_connection()
    cursor = conn.cursor()

    cursor.execute("""
    SELECT j.*, 
           (SELECT COUNT(*) FROM issues WHERE job_id = j.job_id) as issues_count
    FROM jobs j
    ORDER BY j.created_at DESC
    """)
    rows = cursor.fetchall()
    conn.close()

    history = []
    for r in rows:
        history.append({
            "jobId": r["job_id"],
            "name": r["name"],
            "fileName": r["file_name"],
            "uploadedAt": r["created_at"],
            "rowCount": r["row_count"],
            "columnCount": r["column_count"],
            "issuesCount": r["issues_count"],
            "correctionsApplied": r["applied_corrections_count"],
            "scoreBefore": r["score_before_overall"],
            "scoreAfter": r["score_after_overall"],
            "status": r["status"]
        })
    return history

def update_correction_item(job_id: str, correction_id: Optional[str], status: Optional[str], edited_value: Optional[str] = None):
    conn = get_connection()
    cursor = conn.cursor()

    if correction_id:
        if edited_value is not None and status:
            cursor.execute("UPDATE corrections SET status = ?, edited_value = ? WHERE job_id = ? AND id = ?",
                           (status, edited_value, job_id, correction_id))
        elif status:
            cursor.execute("UPDATE corrections SET status = ? WHERE job_id = ? AND id = ?",
                           (status, job_id, correction_id))
        elif edited_value is not None:
            cursor.execute("UPDATE corrections SET edited_value = ? WHERE job_id = ? AND id = ?",
                           (edited_value, job_id, correction_id))

    conn.commit()
    conn.close()

def bulk_update_corrections(job_id: str, action: str):
    conn = get_connection()
    cursor = conn.cursor()

    if action == "approve_all":
        cursor.execute("UPDATE corrections SET status = 'approved' WHERE job_id = ? AND status = 'pending'", (job_id,))
    elif action == "reject_all":
        cursor.execute("UPDATE corrections SET status = 'rejected' WHERE job_id = ? AND status = 'pending'", (job_id,))
    elif action == "approve_safe":
        cursor.execute("""
        UPDATE corrections 
        SET status = 'approved' 
        WHERE job_id = ? AND status = 'pending'
          AND issue_id IN (SELECT id FROM issues WHERE job_id = ? AND severity != 'critical')
        """, (job_id, job_id))

    conn.commit()
    conn.close()
