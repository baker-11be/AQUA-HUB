from src.data_loader import load_questionnaire_data
from src.preprocessing import preprocess_data
from src.feature_engineering import engineer_features
from src.anomaly_detection import train_isolation_forest, save_model, predict_anomalies
from src.explanation import explain_anomalies


def main():
    df = load_questionnaire_data("data/raw/questionnaire_data.csv")
    processed = preprocess_data(df)
    features = engineer_features(processed)
    model = train_isolation_forest(features)
    save_model(model)

    results = predict_anomalies(features, model)
    explained = explain_anomalies(results)
    print(explained[["interview_id", "anomaly_flag", "anomaly_score", "explanation"]].head(10).to_string(index=False))


if __name__ == "__main__":
    main()
