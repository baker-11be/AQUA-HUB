from __future__ import annotations

import pandas as pd


def explain_anomalies(df: pd.DataFrame) -> pd.DataFrame:
    """Generate human-readable explanations for flagged anomalies."""
    explanations = df.copy()
    avg_response_baseline = explanations["avg_response_time"].mean()
    avg_pause_baseline = explanations["avg_pause_seconds"].mean()

    def summarize(row):
        reasons = []
        if row["avg_response_time"] > avg_response_baseline * 1.5:
            reasons.append("response time is unusually high")
        if row["avg_pause_seconds"] > avg_pause_baseline * 1.5:
            reasons.append("pause time is unusually high")
        if row["inconsistency_rate"] > 0.1:
            reasons.append("timing inconsistencies were detected")
        if row["long_pause_ratio"] > 0.2:
            reasons.append("frequent long pauses suggest interruption or inactivity")
        if row["anomaly_flag"] == 0:
            return "No anomaly detected"
        if not reasons:
            reasons.append("statistical anomaly in questionnaire timing patterns")
        return "; ".join(reasons)

    explanations["explanation"] = explanations.apply(summarize, axis=1)
    return explanations
