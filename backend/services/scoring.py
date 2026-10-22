"""
Transparent, Reproducible Quality Scoring Formula
Quality Score = (Completeness * W1) + (Validity * W2) + (Uniqueness * W3) + (Consistency * W4)
"""
from typing import Dict, Any, List

DEFAULT_WEIGHTS = {
    "completeness": 0.30,
    "validity": 0.30,
    "uniqueness": 0.20,
    "consistency": 0.20
}

def calculate_quality_score(
    total_rows: int,
    total_cols: int,
    issues: List[Dict[str, Any]],
    weights: Dict[str, float] = None
) -> Dict[str, Any]:
    if weights is None:
        weights = DEFAULT_WEIGHTS

    total_cells = max(1, total_rows * total_cols)

    # Missing counts
    missing_issues = [i for i in issues if i["category"] == "missing_value"]
    missing_cells = sum(len(i["affectedRows"]) for i in missing_issues)
    completeness = max(0.0, min(100.0, ((total_cells - missing_cells) / total_cells) * 100))

    # Duplicate counts
    dup_issues = [i for i in issues if i["category"] == "duplicate_record"]
    dup_rows = sum(len(i["affectedRows"]) for i in dup_issues)
    uniqueness = max(0.0, min(100.0, ((total_rows - dup_rows) / max(1, total_rows)) * 100))

    # Validity
    val_issues = [i for i in issues if i["category"] in ["invalid_format", "business_rule_violation"]]
    invalid_cells = sum(len(i["affectedRows"]) for i in val_issues)
    validity = max(0.0, min(100.0, ((total_cells - invalid_cells) / total_cells) * 100))

    # Consistency
    cons_issues = [i for i in issues if i["category"] in ["inconsistent_category", "potential_outlier"]]
    inconsistent_cells = sum(len(i["affectedRows"]) for i in cons_issues)
    consistency = max(0.0, min(100.0, ((total_cells - inconsistent_cells) / total_cells) * 100))

    w_sum = sum(weights.values()) or 1.0
    w_comp = weights["completeness"] / w_sum
    w_val = weights["validity"] / w_sum
    w_uniq = weights["uniqueness"] / w_sum
    w_cons = weights["consistency"] / w_sum

    overall = (completeness * w_comp) + (validity * w_val) + (uniqueness * w_uniq) + (consistency * w_cons)

    return {
        "overall": round(overall, 1),
        "completeness": round(completeness, 1),
        "validity": round(validity, 1),
        "uniqueness": round(uniqueness, 1),
        "consistency": round(consistency, 1),
        "weights": {
            "completeness": round(w_comp, 2),
            "validity": round(w_val, 2),
            "uniqueness": round(w_uniq, 2),
            "consistency": round(w_cons, 2)
        },
        "unresolvedIssues": len([i for i in issues if i["resolutionStatus"] == "pending"]),
        "explanation": f"Score computed from Completeness ({completeness:.1f}%), Validity ({validity:.1f}%), Uniqueness ({uniqueness:.1f}%), Consistency ({consistency:.1f}%)."
    }
