import hashlib
import json
import os
import re
import secrets
import sqlite3
import tempfile
import warnings
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = Path(os.environ.get("AQUA_DB_PATH", ROOT / "data" / "aqua_hub.sqlite3"))
AUDIO_DIR = Path(os.environ.get("AQUA_AUDIO_DIR", ROOT / "data" / "audio"))
IS_PRODUCTION = os.environ.get("AQUA_ENV", "development").lower() == "production"
SESSION_COOKIE = "aqua_session"
SESSION_HOURS = 12
PASSWORD_ITERATIONS = 310_000
app = FastAPI(title="Aqua Hub Interview API")
_transcription_model = None
_isolation_model = None
_isolation_model_source = None


@contextmanager
def database():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    try:
        yield connection
        connection.commit()
    finally:
        connection.close()


def hash_password(password, salt=None):
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, PASSWORD_ITERATIONS)
    return salt.hex(), digest.hex()


def add_bootstrap_user(connection, username, password, role):
    if not username or not password:
        return
    salt, digest = hash_password(password)
    connection.execute(
        "INSERT OR IGNORE INTO users (username, salt, password_hash, role) VALUES (?, ?, ?, ?)",
        (username.strip().upper(), salt, digest, role),
    )


def initialize_database():
    with database() as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY,
                username TEXT NOT NULL UNIQUE,
                salt TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL CHECK(role IN ('enumerator', 'supervisor')),
                active INTEGER NOT NULL DEFAULT 1,
                must_change_password INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                expires_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS interviews (
                interview_id TEXT PRIMARY KEY,
                enumerator TEXT NOT NULL REFERENCES users(username),
                respondent TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('draft', 'submitted')),
                payload TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                reviewed_by TEXT,
                reviewed_at TEXT
            );
            CREATE INDEX IF NOT EXISTS interviews_status_updated
                ON interviews(status, updated_at DESC);
            CREATE TABLE IF NOT EXISTS audit_events (
                id INTEGER PRIMARY KEY,
                username TEXT NOT NULL,
                action TEXT NOT NULL,
                interview_id TEXT,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS interview_audio (
                id INTEGER PRIMARY KEY,
                interview_id TEXT NOT NULL,
                question_id TEXT NOT NULL,
                filename TEXT NOT NULL UNIQUE,
                mime_type TEXT NOT NULL,
                recorded_at TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            """
        )
        interview_columns = {row["name"] for row in connection.execute("PRAGMA table_info(interviews)")}
        if "reviewed_by" not in interview_columns:
            connection.execute("ALTER TABLE interviews ADD COLUMN reviewed_by TEXT")
        if "reviewed_at" not in interview_columns:
            connection.execute("ALTER TABLE interviews ADD COLUMN reviewed_at TEXT")
        user_columns = {row["name"] for row in connection.execute("PRAGMA table_info(users)")}
        if "active" not in user_columns:
            connection.execute("ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1")
        if "must_change_password" not in user_columns:
            connection.execute("ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0")
        if not connection.execute("SELECT 1 FROM users WHERE role = 'enumerator' LIMIT 1").fetchone():
            if IS_PRODUCTION:
                add_bootstrap_user(
                    connection,
                    os.environ.get("AQUA_BOOTSTRAP_ENUMERATOR_USER"),
                    os.environ.get("AQUA_BOOTSTRAP_ENUMERATOR_PASSWORD"),
                    "enumerator",
                )
            else:
                add_bootstrap_user(connection, "ENUM001", "field-demo-2026", "enumerator")
        if not connection.execute("SELECT 1 FROM users WHERE role = 'supervisor' LIMIT 1").fetchone():
            if IS_PRODUCTION:
                add_bootstrap_user(
                    connection,
                    os.environ.get("AQUA_BOOTSTRAP_SUPERVISOR_USER"),
                    os.environ.get("AQUA_BOOTSTRAP_SUPERVISOR_PASSWORD"),
                    "supervisor",
                )
            else:
                add_bootstrap_user(connection, "SUPERVISOR", "monitor-demo-2026", "supervisor")


def get_current_user(request: Request):
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        raise HTTPException(status_code=401, detail="Sign in to continue.")
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    now = datetime.now(timezone.utc).isoformat()
    with database() as connection:
        row = connection.execute(
                """SELECT users.id, users.username, users.role, users.must_change_password
               FROM sessions JOIN users ON users.id = sessions.user_id
                    WHERE sessions.token_hash = ? AND sessions.expires_at > ? AND users.active = 1""",
            (token_hash, now),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=401, detail="Your session expired. Sign in again.")
    return dict(row)


def require_role(*roles):
    def dependency(user=Depends(get_current_user)):
        if user["role"] not in roles:
            raise HTTPException(status_code=403, detail="Your account cannot access this resource.")
        if user["must_change_password"]:
            raise HTTPException(status_code=403, detail="Change your temporary password before continuing.")
        return user

    return dependency


def record_audit_event(connection, username, action, interview_id=None):
    connection.execute(
        "INSERT INTO audit_events (username, action, interview_id, created_at) VALUES (?, ?, ?, ?)",
        (username, action, interview_id, datetime.now(timezone.utc).isoformat()),
    )


@app.post("/api/interviews/{interview_id}/audio")
async def save_interview_audio(interview_id: str, request: Request, question_id: str, user=Depends(require_role("enumerator"))):
    data = await request.body()
    if not data or len(data) > 20 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Audio must be smaller than 20 MB.")
    if not re.fullmatch(r"Q\d{2}", question_id):
        raise HTTPException(status_code=422, detail="Invalid questionnaire question.")
    content_type = request.headers.get("content-type", "audio/webm").split(";")[0]
    extension = {"audio/mp4": ".mp4", "audio/ogg": ".ogg", "audio/wav": ".wav", "audio/mpeg": ".mp3"}.get(content_type, ".webm")
    filename = f"{secrets.token_urlsafe(24)}{extension}"
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    (AUDIO_DIR / filename).write_bytes(data)
    recorded_at = datetime.now(timezone.utc).isoformat()
    with database() as connection:
        connection.execute(
            "INSERT INTO interview_audio (interview_id, question_id, filename, mime_type, recorded_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (interview_id, question_id, filename, content_type, recorded_at, recorded_at),
        )
        record_audit_event(connection, user["username"], "record_audio", interview_id)
    return {"audioUrl": f"/api/supervisor/interviews/{interview_id}/audio/{question_id}", "recordedAt": recorded_at}


@app.get("/api/supervisor/interviews/{interview_id}/audio/{question_id}")
def get_interview_audio(interview_id: str, question_id: str, user=Depends(require_role("supervisor"))):
    with database() as connection:
        row = connection.execute(
            "SELECT filename, mime_type FROM interview_audio WHERE interview_id = ? AND question_id = ? ORDER BY id DESC LIMIT 1",
            (interview_id, question_id),
        ).fetchone()
    if not row or not (AUDIO_DIR / row["filename"]).is_file():
        raise HTTPException(status_code=404, detail="Audio record not found.")
    return FileResponse(AUDIO_DIR / row["filename"], media_type=row["mime_type"], filename=row["filename"])


def apply_quality_checks(payload, connection):
    question_keys = {
        "Q01": "name",
        "Q02": "age",
        "Q03": "occupation",
        "Q04": "marital",
        "Q05": "district",
        "Q06": "household",
    }
    previous_rows = connection.execute(
        "SELECT interview_id, payload FROM interviews WHERE status = 'submitted' AND lower(respondent) = lower(?) AND interview_id != ?",
        (payload["respondent"], payload["interviewId"]),
    ).fetchall()
    previous_answers = [
        answer
        for row in previous_rows
        for answer in json.loads(row["payload"]).get("answers", [])
    ]

    for answer in payload["answers"]:
        if not isinstance(answer, dict):
            raise HTTPException(status_code=422, detail="Answers must be questionnaire records.")
        question_id = str(answer.get("id", ""))
        key = answer.get("key") or question_keys.get(question_id)
        response = str(answer.get("response", "")).strip()
        try:
            duration = max(0, float(answer.get("question_duration_seconds", answer.get("response_time_seconds", 0)) or 0))
        except (TypeError, ValueError):
            duration = 0
        try:
            pause_seconds = max(0, float(answer.get("pause_seconds", 0) or 0))
        except (TypeError, ValueError):
            pause_seconds = 0
        flags = []

        def flag(category, message):
            flags.append({"category": category, "message": message})

        if not response:
            flag("missing_value", "Missing response value for this question")
        if duration < 2:
            flag("completion_time", "Answer recorded unusually fast")
        elif duration > 180:
            flag("completion_time", "Answer took longer than expected")
        if pause_seconds > 60:
            flag("completion_time", "Long pause period recorded")
        if key == "name":
            if not response or response.casefold() != payload["respondent"].casefold():
                flag("inconsistency", "Name does not match interview registration")
        if key in ("name", "district") and response:
            normalized_text = response.replace("'", "").replace("-", "").replace(".", "").replace(" ", "")
            if not normalized_text.isalpha():
                flag("inconsistency", f"{key.title()} must be entered as text")
        if key == "age":
            try:
                age = int(response)
            except ValueError:
                age = 0
            if age < 15 or age > 120:
                flag("inconsistency", "Age is outside the expected range")
        if key == "household":
            try:
                household_size = int(response)
            except ValueError:
                household_size = 0
            if household_size < 1 or household_size > 40:
                flag("inconsistency", "Household size is outside the expected range")
        if key == "marital":
            age_answer = next((item for item in payload["answers"] if item.get("id") == "Q02"), {})
            try:
                age = int(str(age_answer.get("response", "")))
            except ValueError:
                age = 0
            if age and age < 18 and response == "Married":
                flag("inconsistency", "Marital status conflicts with reported age")
        if any(
            previous.get("id") == question_id
            and str(previous.get("response", "")).strip().casefold() == response.casefold()
            for previous in previous_answers
        ):
            flag("duplicate", "Duplicate response found for this respondent")

        answer["flags"] = flags
        answer["status"] = "flagged" if flags else "normal"
        answer["response_status"] = "flagged" if flags else "completed"
        answer["anomaly_category"] = flags[0]["category"] if flags else "normal"
        answer["question_duration_seconds"] = duration
        answer["response_time_seconds"] = duration

    flagged_answers = sum(answer["status"] == "flagged" for answer in payload["answers"])
    flag_count = sum(len(answer["flags"]) for answer in payload["answers"])
    risk_score = min(100, flagged_answers * 15 + flag_count * 5)
    payload["quality_summary"] = {
        "flagged_answers": flagged_answers,
        "flag_events": flag_count,
        "risk_score": risk_score,
        "risk_level": "high" if risk_score >= 60 else "moderate" if risk_score >= 30 else "low",
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "method": "server-side questionnaire rules",
    }


def score_submitted_interviews(interviews):
    global _isolation_model, _isolation_model_source
    submitted = [record for record in interviews if record.get("status") == "submitted"]
    if not submitted:
        return {"status": "ready", "scored_interviews": 0}

    try:
        import pandas as pd

        from sklearn.exceptions import InconsistentVersionWarning

        from src.anomaly_detection import MODEL_PATH, load_model, predict_anomalies, train_isolation_forest
        from src.feature_engineering import engineer_features
        from src.preprocessing import preprocess_data

        if not MODEL_PATH.exists():
            return {"status": "unavailable", "scored_interviews": 0}
        rows = []
        for record in submitted:
            for answer in record.get("answers", []):
                rows.append(
                    {
                        "interview_id": record["interviewId"],
                        "interviewer_id": record["enumerator"],
                        "question_id": answer.get("id", ""),
                        "question_start": answer.get("question_started_at"),
                        "question_end": answer.get("question_ended_at"),
                        "response_time_seconds": answer.get("response_time_seconds", 0),
                        "pause_seconds": answer.get("pause_seconds", 0),
                        "question_text": answer.get("rubric") or answer.get("text") or answer.get("id", ""),
                    }
                )
        if not rows:
            return {"status": "unavailable", "scored_interviews": 0}
        processed = preprocess_data(pd.DataFrame(rows))
        features = engineer_features(processed)
        if _isolation_model is None:
            with warnings.catch_warnings(record=True) as model_warnings:
                warnings.simplefilter("always", InconsistentVersionWarning)
                _isolation_model = load_model()
            version_mismatch = any(
                issubclass(warning.category, InconsistentVersionWarning)
                for warning in model_warnings
            )
            if version_mismatch:
                from src.data_loader import load_questionnaire_data

                training_data = load_questionnaire_data(ROOT / "data" / "raw" / "questionnaire_data.csv")
                training_features = engineer_features(preprocess_data(training_data))
                _isolation_model = train_isolation_forest(training_features)
                _isolation_model_source = "runtime-trained from project questionnaire data"
            else:
                _isolation_model_source = "compatible stored model"
        scored = predict_anomalies(features, _isolation_model)
        scores = {}
        for _, row in scored.iterrows():
            interview_id = str(row["interview_id"])
            scores[interview_id] = {
                "status": "anomaly" if int(row["anomaly_flag"]) else "normal",
                "anomaly_score": round(float(row["anomaly_score"]), 4),
                "model": "Isolation Forest",
            }
        return {
            "status": "active",
            "scored_interviews": len(scores),
            "model_source": _isolation_model_source,
            "scores": scores,
        }
    except Exception:
        return {"status": "unavailable", "scored_interviews": 0}


class LoginRequest(BaseModel):
    username: str
    password: str


class EnumeratorCreateRequest(BaseModel):
    username: str
    temporary_password: str


class AccountStatusRequest(BaseModel):
    active: bool


class PasswordChangeRequest(BaseModel):
    new_password: str


class LocalSupervisorResetRequest(BaseModel):
    username: str
    new_password: str


@app.on_event("startup")
def startup():
    initialize_database()


@app.get("/health")
def health_check():
    return {"status": "ok"}


@app.post("/api/auth/login")
def login(credentials: LoginRequest, response: Response):
    username = credentials.username.strip().upper()
    with database() as connection:
        user = connection.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
        if not user or not user["active"]:
            raise HTTPException(status_code=401, detail="Username or password is incorrect.")
        _, digest = hash_password(credentials.password, bytes.fromhex(user["salt"]))
        if not secrets.compare_digest(digest, user["password_hash"]):
            raise HTTPException(status_code=401, detail="Username or password is incorrect.")
        token = secrets.token_urlsafe(32)
        expires_at = datetime.now(timezone.utc) + timedelta(hours=SESSION_HOURS)
        connection.execute(
            "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
            (hashlib.sha256(token.encode()).hexdigest(), user["id"], expires_at.isoformat()),
        )
        record_audit_event(connection, user["username"], "sign_in")
    response.set_cookie(
        SESSION_COOKIE,
        token,
        httponly=True,
        secure=IS_PRODUCTION,
        samesite="lax",
        max_age=SESSION_HOURS * 60 * 60,
        path="/",
    )
    return {
        "username": user["username"],
        "role": user["role"],
        "mustChangePassword": bool(user["must_change_password"]),
    }


@app.post("/api/auth/reset-local-supervisor")
def reset_local_supervisor(payload: LocalSupervisorResetRequest, request: Request):
    if IS_PRODUCTION or not request.client or request.client.host not in {"127.0.0.1", "::1", "localhost"}:
        raise HTTPException(status_code=403, detail="Local development reset is disabled here.")
    if len(payload.new_password) < 12:
        raise HTTPException(status_code=422, detail="Use a password with at least 12 characters.")
    username = payload.username.strip().upper()
    if not re.fullmatch(r"[A-Z0-9_-]{3,32}", username):
        raise HTTPException(status_code=422, detail="Use 3 to 32 letters, numbers, underscores, or hyphens for the username.")
    with database() as connection:
        old_user = connection.execute("SELECT id FROM users WHERE username = 'SUPERVISOR'").fetchone()
        conflicting_user = connection.execute(
            "SELECT id FROM users WHERE username = ? AND username != 'SUPERVISOR'", (username,)
        ).fetchone()
        if conflicting_user:
            raise HTTPException(status_code=409, detail="That username is already in use.")
        salt, digest = hash_password(payload.new_password)
        if old_user:
            connection.execute(
                "UPDATE users SET username = ?, salt = ?, password_hash = ?, role = 'supervisor', active = 1, must_change_password = 0 WHERE id = ?",
                (username, salt, digest, old_user["id"]),
            )
        else:
            connection.execute(
                "INSERT INTO users (username, salt, password_hash, role, active, must_change_password) VALUES (?, ?, ?, 'supervisor', 1, 0)",
                (username, salt, digest),
            )
        connection.execute("DELETE FROM sessions WHERE user_id = ?", (old_user["id"],)) if old_user else None
        record_audit_event(connection, "LOCAL_RESET", "reset_supervisor_credentials", username)
    return {"status": "reset", "username": username}


@app.get("/api/auth/me")
def who_am_i(request: Request):
    try:
        user = get_current_user(request)
    except HTTPException as error:
        if error.status_code == 401:
            return {"authenticated": False}
        raise
    return {
        "username": user["username"],
        "role": user["role"],
        "mustChangePassword": bool(user["must_change_password"]),
        "authenticated": True,
    }


@app.post("/api/auth/change-password")
def change_password(payload: PasswordChangeRequest, request: Request, user=Depends(get_current_user)):
    if len(payload.new_password) < 12:
        raise HTTPException(status_code=422, detail="Use a password with at least 12 characters.")
    with database() as connection:
        salt, new_digest = hash_password(payload.new_password)
        connection.execute(
            "UPDATE users SET salt = ?, password_hash = ?, must_change_password = 0 WHERE id = ?",
            (salt, new_digest, user["id"]),
        )
        token = request.cookies.get(SESSION_COOKIE)
        if token:
            connection.execute(
                "DELETE FROM sessions WHERE user_id = ? AND token_hash != ?",
                (user["id"], hashlib.sha256(token.encode()).hexdigest()),
            )
        record_audit_event(connection, user["username"], "change_password")
    return {"username": user["username"], "role": user["role"], "mustChangePassword": False}


@app.post("/api/auth/logout")
def logout(request: Request, response: Response):
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        with database() as connection:
            user = connection.execute(
                "SELECT users.username FROM sessions JOIN users ON users.id = sessions.user_id WHERE token_hash = ?",
                (hashlib.sha256(token.encode()).hexdigest(),),
            ).fetchone()
            connection.execute(
                "DELETE FROM sessions WHERE token_hash = ?",
                (hashlib.sha256(token.encode()).hexdigest(),),
            )
            if user:
                record_audit_event(connection, user["username"], "sign_out")
    response.delete_cookie(SESSION_COOKIE, path="/", httponly=True, secure=IS_PRODUCTION, samesite="lax")
    return {"status": "signed out"}


@app.post("/api/interviews")
def save_interview(payload: dict, user=Depends(require_role("enumerator"))):
    interview_id = str(payload.get("interviewId", "")).strip()
    respondent = str(payload.get("respondent", "")).strip()
    if not interview_id or len(interview_id) > 80 or not respondent:
        raise HTTPException(status_code=422, detail="Interview ID and respondent name are required.")
    payload = {**payload, "enumerator": user["username"]}
    status = "submitted" if payload.get("completedAt") else "draft"
    now = datetime.now(timezone.utc).isoformat()
    with database() as connection:
        existing = connection.execute(
            "SELECT enumerator, status FROM interviews WHERE interview_id = ?", (interview_id,)
        ).fetchone()
        if existing and existing["enumerator"] != user["username"]:
            raise HTTPException(status_code=409, detail="This interview belongs to another enumerator.")
        if existing and existing["status"] == "submitted":
            return {"interviewId": interview_id, "status": "submitted", "updatedAt": now}
        if not isinstance(payload.get("answers"), list):
            raise HTTPException(status_code=422, detail="Interview answers must be a list.")
        if status == "submitted":
            expected_questions = {"Q01", "Q02", "Q03", "Q04", "Q05", "Q06"}
            answered_questions = {
                str(answer.get("id", "")) for answer in payload["answers"] if isinstance(answer, dict)
            }
            if answered_questions != expected_questions:
                raise HTTPException(status_code=422, detail="Complete all questionnaire answers before submitting.")
        apply_quality_checks(payload, connection)
        connection.execute(
            """INSERT INTO interviews (interview_id, enumerator, respondent, status, payload, updated_at)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(interview_id) DO UPDATE SET
                 respondent = excluded.respondent, status = excluded.status,
                 payload = excluded.payload, updated_at = excluded.updated_at""",
            (interview_id, user["username"], respondent, status, json.dumps(payload), now),
        )
        if status == "submitted":
            record_audit_event(connection, user["username"], "submit_interview", interview_id)
    return {"interviewId": interview_id, "status": status, "updatedAt": now}


@app.get("/api/interviews/drafts")
def list_drafts(user=Depends(require_role("enumerator"))):
    with database() as connection:
        rows = connection.execute(
            "SELECT payload FROM interviews WHERE enumerator = ? AND status = 'draft' ORDER BY updated_at DESC",
            (user["username"],),
        ).fetchall()
    return [json.loads(row["payload"]) for row in rows]


@app.delete("/api/interviews/{interview_id}")
def delete_draft(interview_id: str, user=Depends(require_role("enumerator"))):
    with database() as connection:
        connection.execute(
            "DELETE FROM interviews WHERE interview_id = ? AND enumerator = ? AND status = 'draft'",
            (interview_id, user["username"]),
        )
    return {"status": "deleted"}


@app.get("/api/supervisor/dashboard")
def supervisor_dashboard(user=Depends(require_role("supervisor"))):
    with database() as connection:
        record_audit_event(connection, user["username"], "view_monitor")
        rows = connection.execute(
            "SELECT status, payload, updated_at, reviewed_by, reviewed_at FROM interviews ORDER BY updated_at DESC"
        ).fetchall()
        audit_rows = connection.execute(
            "SELECT username, action, interview_id, created_at FROM audit_events ORDER BY id DESC LIMIT 25"
        ).fetchall()
    interviews = []
    for row in rows:
        payload = json.loads(row["payload"])
        payload["status"] = row["status"]
        payload["updatedAt"] = row["updated_at"]
        payload["reviewedBy"] = row["reviewed_by"]
        payload["reviewedAt"] = row["reviewed_at"]
        interviews.append(payload)
    model_status = score_submitted_interviews(interviews)
    for interview in interviews:
        interview["model_assessment"] = model_status.get("scores", {}).get(interview["interviewId"])
    return {
        "interviews": interviews,
        "audit": [dict(row) for row in audit_rows],
        "model": {key: value for key, value in model_status.items() if key != "scores"},
    }


@app.get("/api/supervisor/enumerators")
def list_enumerators(user=Depends(require_role("supervisor"))):
    with database() as connection:
        rows = connection.execute(
            """SELECT users.username, users.active,
                      COUNT(CASE WHEN interviews.status = 'submitted' THEN 1 END) AS submitted_count,
                      COUNT(CASE WHEN interviews.status = 'draft' THEN 1 END) AS draft_count,
                      MAX(interviews.updated_at) AS last_activity
               FROM users LEFT JOIN interviews ON interviews.enumerator = users.username
               WHERE users.role = 'enumerator'
               GROUP BY users.id ORDER BY users.username"""
        ).fetchall()
    return [dict(row) for row in rows]


@app.post("/api/supervisor/enumerators")
def create_enumerator(payload: EnumeratorCreateRequest, user=Depends(require_role("supervisor"))):
    username = payload.username.strip().upper()
    if not re.fullmatch(r"[A-Z0-9_-]{3,32}", username):
        raise HTTPException(status_code=422, detail="Use 3 to 32 letters, numbers, underscores, or hyphens for the username.")
    if len(payload.temporary_password) < 12:
        raise HTTPException(status_code=422, detail="Temporary passwords must contain at least 12 characters.")
    salt, digest = hash_password(payload.temporary_password)
    with database() as connection:
        if connection.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone():
            raise HTTPException(status_code=409, detail="That username already exists.")
        connection.execute(
            "INSERT INTO users (username, salt, password_hash, role, must_change_password) VALUES (?, ?, ?, 'enumerator', 1)",
            (username, salt, digest),
        )
        record_audit_event(connection, user["username"], "create_enumerator", username)
    return {"username": username, "role": "enumerator", "mustChangePassword": True}


@app.patch("/api/supervisor/enumerators/{username}")
def set_enumerator_status(username: str, payload: AccountStatusRequest, user=Depends(require_role("supervisor"))):
    username = username.strip().upper()
    with database() as connection:
        account = connection.execute(
            "SELECT id FROM users WHERE username = ? AND role = 'enumerator'", (username,)
        ).fetchone()
        if not account:
            raise HTTPException(status_code=404, detail="Enumerator account not found.")
        connection.execute("UPDATE users SET active = ? WHERE id = ?", (int(payload.active), account["id"]))
        if not payload.active:
            connection.execute("DELETE FROM sessions WHERE user_id = ?", (account["id"],))
        record_audit_event(connection, user["username"], "activate_enumerator" if payload.active else "deactivate_enumerator", username)
    return {"username": username, "active": payload.active}


@app.post("/api/supervisor/interviews/{interview_id}/review")
def review_interview(interview_id: str, user=Depends(require_role("supervisor"))):
    now = datetime.now(timezone.utc).isoformat()
    with database() as connection:
        row = connection.execute(
            "SELECT status FROM interviews WHERE interview_id = ?", (interview_id,)
        ).fetchone()
        if not row or row["status"] != "submitted":
            raise HTTPException(status_code=404, detail="Submitted interview not found.")
        connection.execute(
            "UPDATE interviews SET reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE interview_id = ?",
            (user["username"], now, now, interview_id),
        )
        record_audit_event(connection, user["username"], "review_interview", interview_id)
    return {"interviewId": interview_id, "reviewedBy": user["username"], "reviewedAt": now}


@app.delete("/api/supervisor/interviews")
def clear_interviews(user=Depends(require_role("supervisor"))):
    with database() as connection:
        record_audit_event(connection, user["username"], "clear_interviews")
        connection.execute("DELETE FROM interviews")
    return {"status": "cleared"}


@app.post("/api/voice/transcribe")
async def transcribe_voice(request: Request, user=Depends(require_role("enumerator"))):
    global _transcription_model
    data = await request.body()
    if not data or len(data) > 20 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Audio must be smaller than 20 MB.")
    try:
        from faster_whisper import WhisperModel

        if _transcription_model is None:
            model_name = os.environ.get("AQUA_WHISPER_MODEL", "tiny")
            _transcription_model = WhisperModel(model_name, device="cpu", compute_type="int8")
        content_type = request.headers.get("content-type", "audio/webm").split(";")[0]
        suffix = {"audio/mp4": ".mp4", "audio/ogg": ".ogg", "audio/wav": ".wav"}.get(content_type, ".webm")
        with tempfile.NamedTemporaryFile(suffix=suffix) as temporary:
            temporary.write(data)
            temporary.flush()
            segments, _ = _transcription_model.transcribe(temporary.name, beam_size=1, vad_filter=True)
            transcript = " ".join(segment.text.strip() for segment in segments).strip()
    except ImportError as error:
        raise HTTPException(status_code=503, detail="Server transcription is not installed.") from error
    except Exception as error:
        raise HTTPException(status_code=422, detail="Audio could not be transcribed.") from error
    return {"transcript": transcript}


@app.post("/detect-anomalies")
def detect_anomalies(csv_path: str, user=Depends(require_role("supervisor"))):
    from src.data_loader import load_questionnaire_data
    from src.preprocessing import preprocess_data
    from src.feature_engineering import engineer_features
    from src.anomaly_detection import train_isolation_forest, save_model, predict_anomalies
    from src.explanation import explain_anomalies

    df = load_questionnaire_data(csv_path)
    processed = preprocess_data(df)
    features = engineer_features(processed)
    model = train_isolation_forest(features)
    save_model(model)
    results = predict_anomalies(features, model)
    explained = explain_anomalies(results)
    return explained.to_dict(orient="records")


def frontend_file(filename):
    return FileResponse(ROOT / filename)


@app.get("/", include_in_schema=False)
@app.get("/index.html", include_in_schema=False)
def serve_index():
    return frontend_file("index.html")


@app.get("/styles.css", include_in_schema=False)
@app.get("/app.js", include_in_schema=False)
@app.get("/anomaly_analysis.js", include_in_schema=False)
@app.get("/manifest.webmanifest", include_in_schema=False)
@app.get("/service-worker.js", include_in_schema=False)
@app.get("/icons/aqua-hub.svg", include_in_schema=False)
@app.get("/favicon.ico", include_in_schema=False)
def serve_frontend_asset(request: Request):
    asset = request.url.path.lstrip("/")
    if asset == "favicon.ico":
        asset = "icons/aqua-hub.svg"
    return frontend_file(asset)
