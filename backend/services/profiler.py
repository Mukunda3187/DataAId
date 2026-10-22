"""
Data Profiling Service using Pandas and NumPy
"""
import pandas as pd
import numpy as np
from typing import Dict, Any, List

def profile_dataframe(df: pd.DataFrame) -> List[Dict[str, Any]]:
    profiles = []
    total_rows = len(df)

    for col in df.columns:
        series = df[col]
        non_null_count = int(series.notna().sum())
        missing_count = int(series.isna().sum())
        unique_count = int(series.nunique(dropna=True))

        missing_pct = round((missing_count / total_rows * 100), 2) if total_rows > 0 else 0
        unique_pct = round((unique_count / non_null_count * 100), 2) if non_null_count > 0 else 0

        # Data type detection
        data_type = "string"
        if pd.api.types.is_numeric_dtype(series):
            data_type = "number"
        elif pd.api.types.is_datetime64_any_dtype(series):
            data_type = "date"
        elif pd.api.types.is_bool_dtype(series):
            data_type = "boolean"

        stats: Dict[str, Any] = {}
        if data_type == "number" and non_null_count > 0:
            numeric_series = series.dropna()
            stats["min"] = float(numeric_series.min())
            stats["max"] = float(numeric_series.max())
            stats["mean"] = round(float(numeric_series.mean()), 2)
            stats["median"] = round(float(numeric_series.median()), 2)
            stats["stdDev"] = round(float(numeric_series.std()), 2) if len(numeric_series) > 1 else 0

        # Frequent values
        val_counts = series.value_counts(dropna=True).head(5)
        frequent_values = [{"value": str(k), "count": int(v)} for k, v in val_counts.items()]

        sample_vals = series.dropna().unique()[:5].tolist()

        profile = {
            "name": col,
            "dataType": data_type,
            "nonNullCount": non_null_count,
            "missingCount": missing_count,
            "missingPercentage": missing_pct,
            "uniqueCount": unique_count,
            "uniquePercentage": unique_pct,
            "sampleValues": sample_vals,
            "frequentValues": frequent_values,
            "issuesCount": 0,
            **stats
        }
        profiles.append(profile)

    return profiles
