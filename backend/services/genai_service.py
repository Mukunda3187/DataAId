"""
Google Gemini GenAI Service for DataAId
Provides automated root cause analysis, business impact assessments, and intelligent correction suggestions.
"""
import os
import json
from typing import Dict, Any, Optional

def get_gemini_client():
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key or api_key == "MY_GEMINI_API_KEY" or not api_key.strip():
        return None
    try:
        from google import genai
        return genai.Client(api_key=api_key)
    except Exception as e:
        print(f"Failed to initialize Google GenAI Client: {e}")
        return None

def is_gemini_available() -> bool:
    return get_gemini_client() is not None

def explain_issue_genai(issue: Dict[str, Any], column_info: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """
    Calls Google Gemini 3.8-Flash to diagnose a data quality anomaly.
    Provides structured reason, business impact, potential cause, and proposed correction.
    """
    client = get_gemini_client()

    if client:
        try:
            prompt = f"""
You are an expert Data Quality Engineer and Data Governance Specialist.
Analyze the following detected data quality anomaly and generate an actionable, structured diagnosis.

Issue Details:
- Issue ID: {issue.get('id')}
- Category: {issue.get('category')}
- Column: {issue.get('column')}
- Severity: {issue.get('severity')}
- Description: {issue.get('description')}
- Supporting Evidence: {issue.get('evidence')}
- Suggested Action: {issue.get('suggestedAction')}
- Affected Rows (Sample): {issue.get('affectedRows', [])[:5]}
{f"- Column Schema & Sample: {json.dumps(column_info)}" if column_info else ""}

Respond strictly with valid JSON conforming to this schema:
{{
  "simpleExplanation": "Clear, accessible 1-sentence explanation of what is wrong for non-technical stakeholders.",
  "whyItMatters": "Business and analytical impact of this anomaly (e.g. reporting bias, downstream ML errors, revenue miscalculations).",
  "potentialCause": "Most likely root cause (e.g. upstream form validation omission, manual typing variance, legacy ETL format).",
  "recommendedAction": "Concrete, step-by-step guidance on how to fix or address the issue.",
  "proposedCorrection": "Exact recommended corrected value or handling rule.",
  "assumptionsAndLimitations": "Assumptions made in this correction and any risks.",
  "requiresHumanReview": true or false
}}
"""
            resp = client.models.generate_content(
                model="gemini-3.8-flash",
                contents=prompt,
                config={
                    "response_mime_type": "application/json"
                }
            )

            if resp.text:
                parsed = json.loads(resp.text)
                return {
                    "simpleExplanation": parsed.get("simpleExplanation", issue.get("description", "")),
                    "whyItMatters": parsed.get("whyItMatters", "May distort analytical metrics and downstream reporting."),
                    "potentialCause": parsed.get("potentialCause", "Data entry variance or upstream pipeline mismatch."),
                    "recommendedAction": parsed.get("recommendedAction", issue.get("suggestedAction", "")),
                    "proposedCorrection": str(parsed.get("proposedCorrection", issue.get("proposedValue", ""))),
                    "assumptionsAndLimitations": parsed.get("assumptionsAndLimitations", "Automated Gemini assessment based on column metadata."),
                    "requiresHumanReview": bool(parsed.get("requiresHumanReview", issue.get("severity") in ["critical", "high"])),
                    "provider": "Gemini 3.8-Flash"
                }
        except Exception as e:
            print(f"Error invoking Gemini API: {e}")

    # Fallback: Expert Rule-Based Analysis
    category = issue.get("category", "")
    description = issue.get("description", "")
    
    why_map = {
        "missing_value": "Incomplete records skew aggregate calculations, leading to under-counting and distorted averages.",
        "duplicate_record": "Duplicate entries inflate volume metrics, revenue counts, and customer totals.",
        "inconsistent_category": "Alias and casing variances split identical categories into fragmented buckets in BI dashboards.",
        "invalid_format": "Syntax errors cause ETL ingestion pipeline failures and database type-casting exceptions.",
        "business_rule_violation": "Values outside valid business boundaries invalidate financial reconciliations and compliance.",
        "potential_outlier": "Extreme outliers distort mean-based analytics and statistical models."
    }

    cause_map = {
        "missing_value": "Optional form field submission or upstream extraction omission.",
        "duplicate_record": "Retry mechanism on network timeouts or bulk double-import.",
        "inconsistent_category": "Free-form text input without dropdown validation in source UI.",
        "invalid_format": "Regional date conventions or unvalidated text input.",
        "business_rule_violation": "Missing form validation checks on negative or zero boundaries.",
        "potential_outlier": "Measurement error, currency unit mismatch, or exceptional transaction."
    }

    return {
        "simpleExplanation": description,
        "whyItMatters": why_map.get(category, "Distorts analytical models, dashboards, and reporting accuracy."),
        "potentialCause": cause_map.get(category, "Upstream entry inconsistency or unconstrained source system."),
        "recommendedAction": issue.get("suggestedAction", "Review and apply proposed correction."),
        "proposedCorrection": str(issue.get("proposedValue", "")),
        "assumptionsAndLimitations": "Rule-based expert heuristic applied.",
        "requiresHumanReview": issue.get("severity") in ["critical", "high"],
        "provider": "Rule-based Expert"
    }
