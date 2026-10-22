"""
DataAId FastAPI Backend Entrypoint
Provides modular REST endpoints for Data Quality Monitoring & Auto-Correction
"""
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import pandas as pd
import io
import json
import os
from typing import Optional, Dict, Any

from services.profiler import profile_dataframe
from services.quality_detector import detect_quality_issues
from services.scoring import calculate_quality_score
from services.genai_service import explain_issue_genai

app = FastAPI(
    title="DataAId — Data Quality API",
    description="Data Cleaning & Anomaly Correction Backend",
    version="1.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory storage for jobs
JOBS: Dict[str, Any] = {}

@app.get("/api/status")
def get_status():
    has_gemini = bool(os.getenv("GEMINI_API_KEY") and os.getenv("GEMINI_API_KEY") != "MY_GEMINI_API_KEY")
    provider = "Gemini 3.8-Flash" if has_gemini else "Rule-based Expert Mode"
    return {
        "status": "operational",
        "provider": provider,
        "runtime": "FastAPI with Pandas/NumPy",
        "jobsCount": len(JOBS)
    }

@app.post("/api/upload")
async def upload_file(
    file: UploadFile = File(...),
    dataset_name: Optional[str] = Form(None),
    settings: Optional[str] = Form(None)
):
    try:
        content = await file.read()
        MAX_FILE_SIZE = 300 * 1024 * 1024  # 300 MB
        if len(content) > MAX_FILE_SIZE:
            raise HTTPException(status_code=413, detail="File size exceeds the 300 MB limit.")

        if file.filename.endswith(".xlsx") or file.filename.endswith(".xls"):
            df = pd.read_excel(io.BytesIO(content))
        else:
            df = pd.read_csv(io.StringIO(content.decode("utf-8", errors="ignore")))

        if df.empty:
            raise HTTPException(status_code=400, detail="Uploaded dataset contains no data.")

        job_id = f"JOB-{len(JOBS)+1}"
        parsed_settings = json.loads(settings) if settings else {
            "detectDuplicates": True,
            "detectInconsistentCategories": True,
            "detectOutliers": True
        }

        columns = profile_dataframe(df)
        issues = detect_quality_issues(df, job_id, parsed_settings)
        score = calculate_quality_score(len(df), len(df.columns), issues)

        job_data = {
            "jobId": job_id,
            "summary": {
                "id": job_id,
                "name": dataset_name or file.filename,
                "fileName": file.filename,
                "rowCount": len(df),
                "columnCount": len(df.columns),
                "status": "awaiting_review"
            },
            "columns": columns,
            "rawRows": df.to_dict(orient="records"),
            "issues": issues,
            "scoreBefore": score,
            "appliedCorrectionsCount": 0
        }

        JOBS[job_id] = job_data
        return job_data

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to process dataset: {str(e)}")

@app.get("/api/results/{job_id}")
def get_results(job_id: str):
    if job_id not in JOBS:
        raise HTTPException(status_code=404, detail="Job not found.")
    return JOBS[job_id]

@app.post("/api/ai/explain")
def explain_issue(payload: Dict[str, Any]):
    job_id = payload.get("jobId")
    issue_id = payload.get("issueId")
    if job_id not in JOBS:
        raise HTTPException(status_code=404, detail="Job not found.")
    
    issues = JOBS[job_id]["issues"]
    issue = next((i for i in issues if i["id"] == issue_id), None)
    if not issue:
        raise HTTPException(status_code=404, detail="Issue not found.")

    explanation = explain_issue_genai(issue)
    issue["aiExplanation"] = explanation
    return {"issue": issue, "explanation": explanation}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
