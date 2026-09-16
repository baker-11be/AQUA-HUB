# Questionnaire Anomaly Detection

This project detects anomalies in questionnaire timing data collected as paradata. It tracks interview start/end times, question durations, pauses, and timing inconsistencies and flags suspicious cases for supervisor review.

## Project structure

- `data/raw/` contains raw CSV questionnaire files.
- `src/` contains the processing, feature engineering, anomaly detection, and explanation modules.
- `api/` contains a FastAPI service for submitting a CSV and returning anomaly results.
- `dashboard/` contains a Streamlit dashboard for supervision review.
- `models/` stores the trained Isolation Forest model.

## Typical workflow

1. Collect paradata from the questionnaire system.
2. Load data and preprocess timestamps and durations.
3. Engineer interview-level timing features.
4. Fit an Isolation Forest model.
5. Flag suspicious interviews and explain likely causes.
6. Review flagged sessions in the dashboard or API.

## Run locally

```bash
python generate_data.py
python train_model.py
python predict.py
```

## API

```bash
uvicorn api.main:app --reload
```

Then visit:

- `http://127.0.0.1:8000/health`
- `http://127.0.0.1:8000/docs`

## Dashboard

```bash
streamlit run dashboard/app.py
```

## AI data quality and anomaly detection focus

This sprint focuses on the following 10 anomalies in data collection:

1. Missing data: detect unanswered or incomplete fields and flag them for follow-up.
2. Duplicate records: identify repeated household or respondent data captured more than once.
3. Unusually short interviews: flag interviews completed far faster than expected.
4. Unusually long interviews: flag interviews that take significantly longer than normal.
5. Long inactivity periods: identify when an enumerator leaves the questionnaire idle for too long.
6. Inconsistent responses: detect contradictions within the same questionnaire.
7. Outliers/extreme values: flag unusual values such as very high household size or income.
8. Time overlap: detect when one enumerator appears to conduct multiple interviews at the same time.
9. Suspiciously identical interview times: flag repeated interviews with the same or nearly the same duration.
10. Unusual location/time patterns: detect interviews conducted outside the expected geography or at odd times.

## Main concept

AI collects -> checks missing data -> detects duplicates -> checks consistency -> analyzes interview duration -> detects unusual values -> flags suspicious records -> supervisor reviews them.

## Features used by the model

- average response time
- variability in response time
- maximum response time
- average pause duration
- long pause ratio
- timing inconsistency rate
- interview-level pause/response imbalance
- missing response indicators
- duplicate respondent matching
- time-based overlap and duration checks

## Anomaly logic

The solution uses the following inputs:

- Interview start and end times
- Question start and end timestamps
- Time spent per question
- Pause/resume times
- Interviewer and device metadata
- Household and respondent identifiers
- Response consistency checks across questions
- Geographic and time-of-day fields when available

A trained `IsolationForest` model identifies unusual combinations of these timing and quality signals and marks them as suspicious for supervisor review.

## Implementation direction

The AI sprint should combine both rule-based checks and statistical anomaly detection:

- Rule-based checks cover missing data, duplicates, contradictions, extreme values, and overlap logic.
- Timing and behavior models cover unusually fast/slow interviews, long inactivity, and suspiciously repeated durations.
- The dashboard and supervisor review layer should present the highest-risk records first for manual verification.
