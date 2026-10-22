"""
Comprehensive Test Suite for DataAId Backend
Verifies Upload, Detection, Correction, Gemini, History, Reports, and Downloads.
"""
import sys
import os
sys.path.append(os.path.dirname(__file__))

import json
from fastapi.testclient import TestClient
from main import app
from database import list_history

client = TestClient(app)

def run_tests():
    print("=== STARTING COMPREHENSIVE TEST SUITE ===")

    # 1. Status Check
    print("\n[1/8] Testing /api/status...")
    res = client.get("/api/status")
    assert res.status_code == 200, f"Status failed: {res.text}"
    status_data = res.json()
    print(f"  -> Provider: {status_data['provider']}, Storage: {status_data['storage']}")
    assert "IBM" not in json.dumps(status_data), "IBM found in status!"
    assert "watsonx" not in json.dumps(status_data), "watsonx found in status!"

    # 2. Upload CSV Dataset
    print("\n[2/8] Testing /api/upload (JSON CSV payload)...")
    csv_content = """Transaction_ID,Region,Price,Units
TX-101,Hyderabad,100.0,2
TX-102,hyd,-50.0,1
TX-103,Bengaluru,80.0,
TX-101,Hyderabad,100.0,2
TX-104,Mumbai,50000.0,1"""

    upload_payload = {
        "fileName": "test_sales.csv",
        "fileContent": csv_content,
        "fileType": "csv",
        "datasetName": "Test Sales Dataset"
    }
    res = client.post("/api/upload", json=upload_payload)
    assert res.status_code == 200, f"Upload failed: {res.text}"
    job_data = res.json()
    job_id = job_data["jobId"]
    print(f"  -> Job created: {job_id}, rows: {len(job_data['rawRows'])}, columns: {len(job_data['columns'])}")
    assert len(job_data["rawRows"]) == 5, "Expected 5 rows"
    assert len(job_data["issues"]) > 0, "Expected detected issues"
    print(f"  -> Issues detected: {len(job_data['issues'])}")
    for iss in job_data["issues"]:
        print(f"     * [{iss['category']}] {iss['column']}: {iss['description']}")

    # 3. Fetch Results from Persistent Storage
    print(f"\n[3/8] Testing /api/results/{job_id}...")
    res = client.get(f"/api/results/{job_id}")
    assert res.status_code == 200, f"Get results failed: {res.text}"
    fetched = res.json()
    assert fetched["jobId"] == job_id
    assert len(fetched["rawRows"]) == 5
    print("  -> Successfully fetched analysis from persistent database.")

    # 4. Test Gemini Explanation
    print(f"\n[4/8] Testing /api/ai/explain on issue: {job_data['issues'][0]['id']}...")
    res = client.post("/api/ai/explain", json={
        "jobId": job_id,
        "issueId": job_data["issues"][0]["id"]
    })
    assert res.status_code == 200, f"AI explain failed: {res.text}"
    explain_data = res.json()
    print(f"  -> AI Provider: {explain_data['explanation']['provider']}")
    print(f"  -> Simple Explanation: {explain_data['explanation']['simpleExplanation']}")

    # 5. Update Corrections
    print("\n[5/8] Testing /api/corrections/update (Approve All)...")
    res = client.post("/api/corrections/update", json={
        "jobId": job_id,
        "bulkAction": "approve_all"
    })
    assert res.status_code == 200, f"Update corrections failed: {res.text}"
    cors = res.json()["corrections"]
    assert all(c["status"] == "approved" for c in cors), "All corrections should be approved"
    print(f"  -> Approved {len(cors)} corrections.")

    # 6. Apply Approved Corrections Safely
    print("\n[6/8] Testing /api/corrections/apply (Safe data preservation)...")
    orig_raw_rows_count = len(job_data["rawRows"])
    res = client.post("/api/corrections/apply", json={
        "jobId": job_id,
        "approveAll": False
    })
    assert res.status_code == 200, f"Apply failed: {res.text}"
    applied_analysis = res.json()

    # Verify original raw rows are safe and preserved
    assert len(applied_analysis["rawRows"]) == orig_raw_rows_count, "rawRows must be completely preserved!"
    assert applied_analysis["cleanedRows"] is not None, "cleanedRows must be present"
    # Duplicate row TX-101 was dropped in cleanedRows
    assert len(applied_analysis["cleanedRows"]) == orig_raw_rows_count - 1, "Duplicate row should be deduplicated in cleanedRows"
    print(f"  -> rawRows preserved: {len(applied_analysis['rawRows'])} rows")
    print(f"  -> cleanedRows produced: {len(applied_analysis['cleanedRows'])} rows")
    print(f"  -> Score Before: {applied_analysis['scoreBefore']['overall']} -> Score After: {applied_analysis['scoreAfter']['overall']}")

    # 7. Check Persistent History
    print("\n[7/8] Testing /api/history...")
    res = client.get("/api/history")
    assert res.status_code == 200, f"History failed: {res.text}"
    history_items = res.json()
    print(f"  -> Total jobs in database history: {len(history_items)}")
    assert any(h["jobId"] == job_id for h in history_items), "Created job should be in history"

    # 8. Report and Downloads
    print(f"\n[8/8] Testing /api/report/{job_id} and /api/download/{job_id}...")
    res = client.get(f"/api/report/{job_id}")
    assert res.status_code == 200, f"Report failed: {res.text}"
    report = res.json()
    print(f"  -> Report generated with {report['issuesCount']} issues, {report['appliedCount']} applied corrections")

    res_csv = client.get(f"/api/download/{job_id}?type=cleaned_csv")
    assert res_csv.status_code == 200, "Cleaned CSV download failed"
    assert "text/csv" in res_csv.headers["content-type"]
    print("  -> Cleaned CSV downloaded successfully.")

    res_issues = client.get(f"/api/download/{job_id}?type=issues_csv")
    assert res_issues.status_code == 200, "Issues CSV download failed"
    print("  -> Issues CSV downloaded successfully.")

    print("\n=== ALL TESTS PASSED SUCCESSFULLY! ===")

if __name__ == "__main__":
    run_tests()
