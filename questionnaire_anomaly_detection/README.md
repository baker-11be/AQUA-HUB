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
pip install -r requirements.txt
uvicorn api.main:app --reload
```

Open `http://127.0.0.1:8000` to use Aqua Hub. The same-origin API and PWA shell are served together. The local development accounts are:

- Enumerator: `ENUM001` / `field-demo-2026`
- Supervisor: `SUPERVISOR` / `monitor-demo-2026`

These demo accounts are created only when `AQUA_ENV` is not `production`. For production, set `AQUA_ENV=production`, use a separate persistent `AQUA_DB_PATH`, and configure `AQUA_BOOTSTRAP_ENUMERATOR_USER`, `AQUA_BOOTSTRAP_ENUMERATOR_PASSWORD`, `AQUA_BOOTSTRAP_SUPERVISOR_USER`, and `AQUA_BOOTSTRAP_SUPERVISOR_PASSWORD` before starting the service. Serve production over HTTPS so session cookies and microphone access are protected. Do not reuse the local development database in production.

The enumerator app installs as a PWA from a supported browser and caches its app shell. Interview drafts and pending submissions are stored in IndexedDB on the device and synchronized when the connection returns. The supervisor monitor is served only through supervisor-authorized API routes. It combines server-side questionnaire checks with the trained Isolation Forest; if a saved model was built with a different scikit-learn version, the API trains a compatible in-memory copy from the project's raw questionnaire data and preserves the saved artifact. Voice recording is disabled unless the respondent has consented. Recordings are transcribed on the server with Faster Whisper; its small `tiny` model is downloaded on the first transcription request. Audio remains only in the local draft queue when transcription cannot be reached; use locked, managed devices because local drafts are stored in browser IndexedDB.

For phone installation, deploy the app at an HTTPS address first. On Android, open the address in Chrome and choose **Install app** or **Add to Home screen**. On iPhone or iPad, open it in Safari, choose **Share**, then **Add to Home Screen**. `127.0.0.1` is only reachable from the computer running the server; a phone needs the deployed HTTPS address. Microphone capture also requires a secure HTTPS origin and user permission.

Run the API tests with:

```bash
python -m unittest discover -s tests -p "test_api.py"
```

The existing CSV anomaly endpoint remains available to supervisor accounts at `/detect-anomalies`.

Health and API documentation:

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
