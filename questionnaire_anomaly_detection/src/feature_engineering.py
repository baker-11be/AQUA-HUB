from __future__ import annotations

import pandas as pd


def engineer_features(df: pd.DataFrame) -> pd.DataFrame:
    """Aggregate per interview to detect unusual response, pause, and inconsistency patterns."""
    features = (
        df.groupby("interview_id", as_index=False)
        .agg(
            interviewer_id=("interviewer_id", "first"),
            question_count=("question_id", "count"),
            total_response_time=("response_time_seconds", "sum"),
            avg_response_time=("response_time_seconds", "mean"),
            std_response_time=("response_time_seconds", "std"),
            max_response_time=("response_time_seconds", "max"),
            total_pause_seconds=("pause_seconds", "sum"),
            avg_pause_seconds=("pause_seconds", "mean"),
            max_pause_seconds=("pause_seconds", "max"),
            total_question_duration=("question_duration_seconds", "sum"),
            avg_question_duration=("question_duration_seconds", "mean"),
            inconsistent_timing_count=("question_duration_seconds", lambda s: (s <= 0).sum()),
            long_pause_count=("pause_seconds", lambda s: (s > 60).sum()),
            missing_question_rate=("question_id", lambda s: 0.0 if len(s) else 0.0),
        )
        .fillna(0)
    )

    features["std_response_time"] = features["std_response_time"].fillna(0)
    features["pause_ratio"] = (
        features["total_pause_seconds"] / (features["total_response_time"] + 1e-6)
    )
    features["response_time_zscore"] = (
        (features["avg_response_time"] - features["avg_response_time"].mean())
        / (features["avg_response_time"].std(ddof=0) + 1e-6)
    )
    features["pause_zscore"] = (
        (features["avg_pause_seconds"] - features["avg_pause_seconds"].mean())
        / (features["avg_pause_seconds"].std(ddof=0) + 1e-6)
    )
    features["inconsistency_rate"] = (
        features["inconsistent_timing_count"] / (features["question_count"] + 1e-6)
    )
    features["long_pause_ratio"] = (
        features["long_pause_count"] / (features["question_count"] + 1e-6)
    )

    return features
