from __future__ import annotations

from pathlib import Path
from typing import Union

import joblib
import pandas as pd
from sklearn.ensemble import IsolationForest


MODEL_PATH = Path(__file__).resolve().parents[1] / "models" / "isolation_forest.joblib"


def train_isolation_forest(features: pd.DataFrame, contamination: float = 0.1) -> IsolationForest:
    """Train an Isolation Forest model on questionnaire timing features."""
    feature_columns = [
        "question_count",
        "avg_response_time",
        "std_response_time",
        "max_response_time",
        "avg_pause_seconds",
        "max_pause_seconds",
        "pause_ratio",
        "response_time_zscore",
        "pause_zscore",
        "inconsistency_rate",
        "long_pause_ratio",
    ]

    model = IsolationForest(contamination=contamination, random_state=42)
    model.fit(features[feature_columns].fillna(0))
    return model


def save_model(model: IsolationForest, model_path: Union[str, Path] = MODEL_PATH) -> None:
    model_path = Path(model_path)
    model_path.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(model, model_path)


def load_model(model_path: Union[str, Path] = MODEL_PATH) -> IsolationForest:
    return joblib.load(model_path)


def predict_anomalies(features: pd.DataFrame, model: IsolationForest | None = None) -> pd.DataFrame:
    """Add anomaly scores and a binary flag for each interview record."""
    if model is None:
        model = load_model()

    feature_columns = [
        "question_count",
        "avg_response_time",
        "std_response_time",
        "max_response_time",
        "avg_pause_seconds",
        "max_pause_seconds",
        "pause_ratio",
        "response_time_zscore",
        "pause_zscore",
        "inconsistency_rate",
        "long_pause_ratio",
    ]

    X = features[feature_columns].fillna(0)
    score = model.decision_function(X)
    pred = model.predict(X)

    output = features.copy()
    output["anomaly_score"] = score
    output["anomaly_flag"] = (pred == -1).astype(int)
    output["anomaly_label"] = output["anomaly_flag"].map({0: "normal", 1: "anomaly"})
    return output
