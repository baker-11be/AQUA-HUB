from __future__ import annotations

import pandas as pd


def preprocess_data(df: pd.DataFrame) -> pd.DataFrame:
    """Clean the raw paradata and prepare it for feature engineering."""
    cleaned = df.copy()

    for col in ["question_start", "question_end"]:
        if col in cleaned.columns:
            cleaned[col] = pd.to_datetime(cleaned[col], errors="coerce")

    numeric_cols = ["response_time_seconds", "pause_seconds"]
    for col in numeric_cols:
        if col in cleaned.columns:
            cleaned[col] = pd.to_numeric(cleaned[col], errors="coerce")

    cleaned["response_time_seconds"] = cleaned["response_time_seconds"].fillna(
        cleaned["response_time_seconds"].median()
    )
    cleaned["pause_seconds"] = cleaned["pause_seconds"].fillna(
        cleaned["pause_seconds"].median()
    )

    cleaned["response_time_seconds"] = cleaned["response_time_seconds"].clip(lower=0)
    cleaned["pause_seconds"] = cleaned["pause_seconds"].clip(lower=0)

    cleaned["question_duration_seconds"] = (
        cleaned["question_end"] - cleaned["question_start"]
    ).dt.total_seconds().fillna(cleaned["response_time_seconds"])
    cleaned["question_duration_seconds"] = cleaned["question_duration_seconds"].clip(
        lower=0
    )

    cleaned = cleaned.sort_values(["interview_id", "question_id"]).reset_index(drop=True)
    return cleaned
