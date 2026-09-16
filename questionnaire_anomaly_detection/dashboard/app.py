import streamlit as st
import pandas as pd

from src.data_loader import load_questionnaire_data
from src.preprocessing import preprocess_data
from src.feature_engineering import engineer_features
from src.anomaly_detection import train_isolation_forest, predict_anomalies
from src.explanation import explain_anomalies

st.set_page_config(page_title="Questionnaire Anomaly Dashboard", layout="wide")
st.title("Questionnaire Timing Anomaly Dashboard")

uploaded_file = st.file_uploader("Upload questionnaire paradata CSV", type=["csv"])

if uploaded_file is not None:
    df = pd.read_csv(uploaded_file)
    processed = preprocess_data(df)
    features = engineer_features(processed)
    model = train_isolation_forest(features)
    results = predict_anomalies(features, model)
    explained = explain_anomalies(results)

    st.subheader("Anomaly Summary")
    st.write(explained[["interview_id", "anomaly_flag", "anomaly_score", "explanation"]])

    st.subheader("Flagged Interviews")
    flagged = explained[explained["anomaly_flag"] == 1]
    if flagged.empty:
        st.info("No anomalies detected in the uploaded data.")
    else:
        st.dataframe(flagged)
