from __future__ import annotations

from pathlib import Path

from src.data_loader import load_questionnaire_data
from src.preprocessing import preprocess_data
from src.feature_engineering import engineer_features
from src.anomaly_detection import load_model, predict_anomalies
from src.explanation import explain_anomalies


def main(csv_path: str | Path = "data/raw/questionnaire_data.csv"):
    df = load_questionnaire_data(csv_path)
    processed = preprocess_data(df)
    features = engineer_features(processed)
    model = load_model()
    results = predict_anomalies(features, model)
    explained = explain_anomalies(results)
    print(explained[["interview_id", "anomaly_flag", "anomaly_score", "explanation"]].to_string(index=False))


if __name__ == "__main__":
    main()
