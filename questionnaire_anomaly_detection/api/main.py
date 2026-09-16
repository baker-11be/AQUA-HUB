from fastapi import FastAPI
import pandas as pd

from src.data_loader import load_questionnaire_data
from src.preprocessing import preprocess_data
from src.feature_engineering import engineer_features
from src.anomaly_detection import train_isolation_forest, save_model, predict_anomalies
from src.explanation import explain_anomalies

app = FastAPI(title="Questionnaire Anomaly Detection API")


@app.get("/health")
def health_check():
    return {"status": "ok"}


@app.post("/detect-anomalies")
def detect_anomalies(csv_path: str):
    df = load_questionnaire_data(csv_path)
    processed = preprocess_data(df)
    features = engineer_features(processed)
    model = train_isolation_forest(features)
    save_model(model)
    results = predict_anomalies(features, model)
    explained = explain_anomalies(results)
    return explained.to_dict(orient="records")
