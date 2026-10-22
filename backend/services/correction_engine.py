"""
Safe Data Correction Engine for DataAId
Ensures original dataset integrity is preserved and only user-approved corrections are applied.
"""
import copy
from typing import List, Dict, Any, Tuple
from services.scoring import calculate_quality_score, DEFAULT_WEIGHTS

def generate_corrections_from_issues(issues: List[Dict[str, Any]], raw_rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Generates structured correction proposals from detected quality issues.
    All corrections start in 'pending' status awaiting user approval.
    """
    corrections = []

    for issue in issues:
        cat = issue.get("category")
        if cat == "duplicate_record":
            for row_ref in issue.get("affectedRows", []):
                corrections.append({
                    "id": f"COR-{issue['id']}-{row_ref}",
                    "issueId": issue["id"],
                    "rowRef": row_ref,
                    "column": "Entire Row",
                    "originalValue": "Duplicate Record",
                    "proposedValue": "DROP_ROW",
                    "reason": "Remove redundant duplicate row while preserving primary instance.",
                    "source": "heuristic_rule",
                    "status": "pending"
                })
        else:
            col = issue.get("column", "")
            for row_ref in issue.get("affectedRows", []):
                row_idx = row_ref - 1
                orig_val = ""
                if 0 <= row_idx < len(raw_rows):
                    orig_val = raw_rows[row_idx].get(col, "")

                proposed = issue.get("proposedValue", "")
                if issue.get("aiExplanation") and issue["aiExplanation"].get("proposedCorrection"):
                    proposed = issue["aiExplanation"]["proposedCorrection"]

                reason = issue.get("suggestedAction") or issue.get("description", "Correct identified quality anomaly.")

                corrections.append({
                    "id": f"COR-{issue['id']}-{row_ref}",
                    "issueId": issue["id"],
                    "rowRef": row_ref,
                    "column": col,
                    "originalValue": orig_val,
                    "proposedValue": str(proposed),
                    "reason": reason,
                    "source": "genai" if issue.get("aiExplanation") else "heuristic_rule",
                    "status": "pending"
                })

    return corrections

def preview_corrections_diff(raw_rows: List[Dict[str, Any]], corrections: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Computes diff between raw dataset and approved corrections without modifying original data.
    """
    approved = [c for c in corrections if c.get("status") == "approved"]
    diffs = []
    total_dropped = 0
    total_modified = 0

    for item in approved:
        final_val = item.get("editedValue") if item.get("editedValue") is not None else item.get("proposedValue")
        if final_val == "DROP_ROW":
            total_dropped += 1
            diffs.append({
                "rowRef": item["rowRef"],
                "column": "Entire Row",
                "before": "Active Record",
                "after": "DELETED / DEDUPLICATED",
                "status": item["status"]
            })
        else:
            total_modified += 1
            diffs.append({
                "rowRef": item["rowRef"],
                "column": item["column"],
                "before": item["originalValue"],
                "after": final_val,
                "status": item["status"]
            })

    return {
        "totalModifiedCells": total_modified,
        "totalDroppedRows": total_dropped,
        "diffs": diffs
    }

def apply_approved_corrections(analysis: Dict[str, Any]) -> Dict[str, Any]:
    """
    Safely applies user-approved corrections to produce a cleaned dataset.
    CRITICAL: Preserves `rawRows` completely untouched so original data is never lost.
    """
    raw_rows = analysis.get("rawRows", [])
    corrections = analysis.get("corrections", [])

    # Deep clone original rows to create a distinct cleaned dataset
    cleaned_rows = copy.deepcopy(raw_rows)
    rows_to_drop = set()
    applied_count = 0

    for item in corrections:
        if item.get("status") == "approved":
            final_val = item.get("editedValue") if item.get("editedValue") is not None else item.get("proposedValue")
            row_idx = item["rowRef"] - 1

            if final_val == "DROP_ROW":
                rows_to_drop.add(row_idx)
                item["status"] = "applied"
                applied_count += 1
            elif 0 <= row_idx < len(cleaned_rows):
                col = item["column"]
                cleaned_rows[row_idx][col] = final_val
                item["status"] = "applied"
                applied_count += 1

    # Filter out dropped duplicate rows
    final_cleaned_rows = [row for idx, row in enumerate(cleaned_rows) if idx not in rows_to_drop]

    # Update issue resolution status if all affected corrections are applied
    for issue in analysis.get("issues", []):
        issue_cors = [c for c in corrections if c.get("issueId") == issue.get("id")]
        if issue_cors and all(c.get("status") == "applied" for c in issue_cors):
            issue["resolutionStatus"] = "resolved"

    # Compute updated quality score for the cleaned dataset
    total_cols = len(analysis.get("columns", []))
    remaining_unresolved = [i for i in analysis.get("issues", []) if i.get("resolutionStatus") != "resolved"]
    score_after = calculate_quality_score(len(final_cleaned_rows), total_cols, remaining_unresolved, DEFAULT_WEIGHTS)

    # Attach cleanedRows and updated score while strictly retaining rawRows
    analysis["cleanedRows"] = final_cleaned_rows
    analysis["scoreAfter"] = score_after
    analysis["appliedCorrectionsCount"] = applied_count
    analysis["summary"]["status"] = "corrected"

    return analysis
