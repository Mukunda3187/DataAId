"""
Modular Data Quality Detection Engine in Python
Detects Missing Values, Duplicates, Inconsistent Categories, Invalid Formats, Business Rules, and Outliers (IQR)
"""
import pandas as pd
import numpy as np
import re
from typing import List, Dict, Any

DEFAULT_CATEGORY_ALIASES = {
    'hyd': 'Hyderabad',
    'hyderabad': 'Hyderabad',
    'bangalore': 'Bengaluru',
    'bengaluru': 'Bengaluru',
    'bombay': 'Mumbai',
    'mumbai': 'Mumbai',
    'delhi': 'New Delhi',
    'new delhi': 'New Delhi',
    'calcutta': 'Kolkata',
    'kolkata': 'Kolkata',
    'madras': 'Chennai',
    'chennai': 'Chennai'
}

def _generate_similar_email(existing_emails: list) -> str:
    """
    Analyses existing email addresses in the column and generates a plausible
    email following the same pattern (e.g. firstname.lastname@domain.com).
    Falls back to a generic placeholder if no pattern can be determined.
    """
    import re as _re
    import random as _random

    valid = [e.strip() for e in existing_emails if isinstance(e, str) and '@' in e and '.' in e.split('@')[-1]]
    if not valid:
        return 'unknown@example.com'

    # Collect domain frequencies
    domains = []
    local_parts = []
    for email in valid:
        parts = email.split('@')
        if len(parts) == 2:
            domains.append(parts[1].lower())
            local_parts.append(parts[0].lower())

    if not domains:
        return 'unknown@example.com'

    # Pick the most common domain
    from collections import Counter as _Counter
    most_common_domain = _Counter(domains).most_common(1)[0][0]

    # Detect local-part separator pattern (.  or _ or - or none)
    separators = {'dot': 0, 'underscore': 0, 'dash': 0, 'none': 0}
    for lp in local_parts:
        if '.' in lp:
            separators['dot'] += 1
        elif '_' in lp:
            separators['underscore'] += 1
        elif '-' in lp:
            separators['dash'] += 1
        else:
            separators['none'] += 1
    dominant_sep = max(separators, key=lambda k: separators[k])

    # Detect average local-part length to pick realistic placeholder names
    avg_len = sum(len(lp) for lp in local_parts) / max(len(local_parts), 1)

    # Synthetic first/last name pools
    first_names = ['john', 'jane', 'alex', 'sam', 'chris', 'taylor', 'morgan', 'jordan']
    last_names = ['smith', 'jones', 'brown', 'davis', 'wilson', 'moore', 'taylor', 'clark']

    sep_char = {'dot': '.', 'underscore': '_', 'dash': '-', 'none': ''}[dominant_sep]

    # If average local part is short (< 6 chars), use first name only
    if avg_len < 6:
        local = _random.choice(first_names)
    else:
        local = f"{_random.choice(first_names)}{sep_char}{_random.choice(last_names)}"

    return f"{local}@{most_common_domain}"

def _choose_numeric_stat(col_name: str) -> str:
    """
    Chooses mean, median, or mode for numerical missing-value imputation
    by analysing the column name:
    - Counts / IDs / codes / ranks → mode  (discrete, categorical-like numbers)
    - Aggregates / totals / averages / ratios / scores / rates → mean  (summable quantities)
    - Measurements / continuous / amounts / prices / ages / weights → median  (skew-resistant)
    Default fallback: median (robust to outliers).
    """
    col_lower = col_name.lower()

    # mode: discrete count-like or identifier-like columns
    mode_keywords = [
        'count', 'cnt', 'num', 'number', 'qty', 'quantity', 'id', 'code',
        'rank', 'tier', 'level', 'class', 'category', 'flag', 'status',
        'frequency', 'votes', 'orders', 'units'
    ]
    # mean: aggregate / ratio / average / rate columns
    mean_keywords = [
        'avg', 'average', 'mean', 'total', 'sum', 'aggregate', 'ratio',
        'rate', 'score', 'index', 'pct', 'percent', 'percentage',
        'revenue', 'sales', 'profit', 'margin', 'yield'
    ]
    # median: continuous measurement columns (default if no match above)
    # (price, amount, cost, salary, age, weight, height, temperature, duration, ...)
    # No explicit list needed — this is the fallback.

    for kw in mode_keywords:
        if kw in col_lower:
            return 'mode'
    for kw in mean_keywords:
        if kw in col_lower:
            return 'mean'
    return 'median'

def detect_quality_issues(df: pd.DataFrame, job_id: str, settings: Dict[str, Any]) -> List[Dict[str, Any]]:
    issues = []
    total_rows = len(df)
    counter = 1

    def gen_id(prefix: str):
        nonlocal counter
        res = f"ISS-{job_id}-{prefix}-{str(counter).zfill(4)}"
        counter += 1
        return res

    # 1. Missing Values
    for col in df.columns:
        null_mask = df[col].isna() | (df[col].astype(str).str.strip().isin(["", "null", "none", "nan", "undefined", "n/a"]))
        missing_indices = (df[null_mask].index + 1).tolist()

        if missing_indices:
            pct = round((len(missing_indices) / total_rows * 100), 1)
            is_id = bool(re.search(r"id|key|code", col, re.IGNORECASE))
            severity = "critical" if is_id else "high" if pct > 20 else "medium" if pct > 5 else "low"
            
            # Determine suitable imputation value
            imputed_val = "Unknown"
            stat_method = None
            if pd.api.types.is_numeric_dtype(df[col]):
                valid_num = df[~null_mask][col]
                if not valid_num.empty:
                    stat_method = _choose_numeric_stat(col)
                    if stat_method == 'mean':
                        imputed_val = round(float(valid_num.mean()), 2)
                    elif stat_method == 'mode':
                        mode_result = valid_num.mode()
                        imputed_val = round(float(mode_result[0]), 2) if not mode_result.empty else round(float(valid_num.median()), 2)
                    else:  # median
                        imputed_val = round(float(valid_num.median()), 2)
                else:
                    imputed_val = 0
            else:
                valid_cat = df[~null_mask][col].dropna().astype(str)
                if not valid_cat.empty:
                    # For email columns: generate a similar email based on existing patterns
                    if 'email' in col.lower():
                        # Extract domain and format from existing emails
                        existing_emails = valid_cat.tolist()
                        generated = _generate_similar_email(existing_emails)
                        imputed_val = generated
                    else:
                        mode_val = valid_cat.mode()
                        if not mode_val.empty:
                            imputed_val = str(mode_val[0])

            # Build suggestedAction message
            if stat_method is not None:
                suggested_action = f'Impute missing cells with column-appropriate statistic ({stat_method}: {imputed_val}).'
            else:
                suggested_action = f'Impute missing cells with calculated default ({imputed_val}).'

            issues.append({
                "id": gen_id("MISS"),
                "jobId": job_id,
                "category": "missing_value",
                "column": col,
                "affectedRows": missing_indices,
                "severity": severity,
                "description": f'Column "{col}" has {len(missing_indices)} missing value(s) ({pct}% of rows).',
                "evidence": f"Encountered in row(s): {missing_indices[:5]}",
                "suggestedAction": suggested_action,
                "proposedValue": imputed_val,
                "resolutionStatus": "pending"
            })

    # 2. Exact Duplicate Records
    if settings.get("detectDuplicates", True):
        dup_mask = df.duplicated(keep="first")
        dup_indices = (df[dup_mask].index + 1).tolist()
        if dup_indices:
            issues.append({
                "id": gen_id("DUP"),
                "jobId": job_id,
                "category": "duplicate_record",
                "column": "Entire Row",
                "affectedRows": dup_indices,
                "severity": "high",
                "description": f"Found {len(dup_indices)} exact duplicate row(s) repeating earlier records.",
                "evidence": f"Duplicate row index: {dup_indices}",
                "suggestedAction": "Deduplicate dataset and retain the primary occurrence.",
                "proposedValue": "DROP_ROW",
                "resolutionStatus": "pending"
            })

    # 3. Inconsistent Categories
    if settings.get("detectInconsistentCategories", True):
        for col in df.columns:
            if df[col].dtype == "object":
                clean_vals = df[col].dropna().astype(str).str.strip()
                for alias, canonical in DEFAULT_CATEGORY_ALIASES.items():
                    alias_mask = clean_vals.str.lower() == alias
                    mismatches = clean_vals[alias_mask & (clean_vals != canonical)]
                    if not mismatches.empty:
                        affected = (mismatches.index + 1).tolist()
                        issues.append({
                            "id": gen_id("CAT"),
                            "jobId": job_id,
                            "category": "inconsistent_category",
                            "column": col,
                            "affectedRows": affected,
                            "severity": "medium",
                            "description": f'Inconsistent category "{alias}" found instead of canonical "{canonical}".',
                            "evidence": f"Rows: {affected}",
                            "suggestedAction": f'Standardize variant to "{canonical}".',
                            "proposedValue": canonical,
                            "resolutionStatus": "pending"
                        })

    # 4. Business Rule Violations (e.g. Negative Prices or Amounts)
    for col in df.columns:
        if pd.api.types.is_numeric_dtype(df[col]):
            if any(term in col.lower() for term in ["price", "cost", "amount", "total", "sales", "revenue", "qty", "quantity"]):
                neg_mask = df[col] < 0
                neg_indices = (df[neg_mask].index + 1).tolist()
                if neg_indices:
                    issues.append({
                        "id": gen_id("RULE"),
                        "jobId": job_id,
                        "category": "business_rule_violation",
                        "column": col,
                        "affectedRows": neg_indices,
                        "severity": "critical",
                        "description": f'Negative value detected in financial column "{col}".',
                        "evidence": f"Rows: {neg_indices}, sample values: {df.loc[neg_mask, col].tolist()[:3]}",
                        "suggestedAction": "Convert to absolute positive value or review transaction journal.",
                        "proposedValue": 0.0,
                        "resolutionStatus": "pending"
                    })

    # 5. Invalid Formats (Email & Dates)
    email_regex = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
    date_regex = re.compile(r"^\d{4}-\d{2}-\d{2}$|^\d{2}/\d{2}/\d{4}$")

    for col in df.columns:
        col_lower = col.lower()
        if "email" in col_lower:
            invalid_rows = []
            for idx, val in df[col].dropna().items():
                if not email_regex.match(str(val).strip()):
                    invalid_rows.append(idx + 1)
            if invalid_rows:
                issues.append({
                    "id": gen_id("FMT"),
                    "jobId": job_id,
                    "category": "invalid_format",
                    "column": col,
                    "affectedRows": invalid_rows,
                    "severity": "high",
                    "description": f'Malformed email syntax in {len(invalid_rows)} row(s).',
                    "evidence": f"Rows: {invalid_rows}",
                    "suggestedAction": "Standardize email syntax or request customer verification.",
                    "proposedValue": "unverified@domain.com",
                    "resolutionStatus": "pending"
                })
        elif "date" in col_lower:
            invalid_dates = []
            for idx, val in df[col].dropna().items():
                s_val = str(val).strip()
                try:
                    pd.to_datetime(s_val)
                except Exception:
                    invalid_dates.append(idx + 1)
            if invalid_dates:
                issues.append({
                    "id": gen_id("FMT"),
                    "jobId": job_id,
                    "category": "invalid_format",
                    "column": col,
                    "affectedRows": invalid_dates,
                    "severity": "high",
                    "description": f'Unparseable date format in {len(invalid_dates)} row(s).',
                    "evidence": f"Rows: {invalid_dates}",
                    "suggestedAction": "Standardize to ISO YYYY-MM-DD format.",
                    "proposedValue": "2024-01-01",
                    "resolutionStatus": "pending"
                })

    # 6. Outliers (IQR Method)
    if settings.get("detectOutliers", True):
        for col in df.columns:
            if pd.api.types.is_numeric_dtype(df[col]):
                series = df[col].dropna()
                if len(series) >= 6:
                    q1 = series.quantile(0.25)
                    q3 = series.quantile(0.75)
                    iqr = q3 - q1
                    if iqr > 0:
                        lower = q1 - 1.5 * iqr
                        upper = q3 + 1.5 * iqr
                        outliers = series[(series < lower) | (series > upper)]
                        if not outliers.empty:
                            outlier_rows = (outliers.index + 1).tolist()
                            issues.append({
                                "id": gen_id("OUT"),
                                "jobId": job_id,
                                "category": "potential_outlier",
                                "column": col,
                                "affectedRows": outlier_rows,
                                "severity": "medium",
                                "description": f'Statistical outlier(s) detected via IQR. Normal bounds: [{lower:.1f}, {upper:.1f}].',
                                "evidence": f"Outlier rows: {outlier_rows}, values: {outliers.tolist()}",
                                "suggestedAction": f'Cap to reasonable boundary or verify transaction.',
                                "proposedValue": round(float(series.median()), 2),
                                "resolutionStatus": "pending"
                            })

    return issues
