import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from api import main


class InterviewApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary_directory = tempfile.TemporaryDirectory()
        cls.original_database_path = main.DB_PATH
        main.DB_PATH = Path(cls.temporary_directory.name) / "test.sqlite3"
        main.initialize_database()

    @classmethod
    def tearDownClass(cls):
        main.DB_PATH = cls.original_database_path
        cls.temporary_directory.cleanup()

    def setUp(self):
        with main.database() as connection:
            connection.execute("DELETE FROM sessions")
            connection.execute("DELETE FROM interviews")
            connection.execute("DELETE FROM audit_events")
            connection.execute("DELETE FROM users WHERE username NOT IN ('ENUM001', 'SUPERVISOR')")

    def request(self, method, path, body=None, cookie=None):
        request_body = json.dumps(body).encode() if body is not None else b""
        headers = [(b"host", b"testserver")]
        if body is not None:
            headers.append((b"content-type", b"application/json"))
        if cookie:
            headers.append((b"cookie", cookie.encode()))
        messages = []
        sent_body = False

        async def receive():
            nonlocal sent_body
            if not sent_body:
                sent_body = True
                return {"type": "http.request", "body": request_body, "more_body": False}
            return {"type": "http.disconnect"}

        async def send(message):
            messages.append(message)

        scope = {
            "type": "http",
            "asgi": {"version": "3.0", "spec_version": "2.3"},
            "http_version": "1.1",
            "method": method,
            "scheme": "http",
            "path": path,
            "raw_path": path.encode(),
            "query_string": b"",
            "root_path": "",
            "headers": headers,
            "client": ("127.0.0.1", 10000),
            "server": ("testserver", 80),
        }
        asyncio.run(main.app(scope, receive, send))
        start = next(message for message in messages if message["type"] == "http.response.start")
        response_body = b"".join(message.get("body", b"") for message in messages if message["type"] == "http.response.body")
        response_headers = dict(start.get("headers", []))
        parsed_body = json.loads(response_body) if response_body else None
        return start["status"], parsed_body, response_headers

    def login(self, username, password):
        status, body, headers = self.request(
            "POST", "/api/auth/login", {"username": username, "password": password}
        )
        self.assertEqual(status, 200, body)
        return headers[b"set-cookie"].decode().split(";", 1)[0]

    def test_enumerator_submissions_are_persisted_and_supervisor_only(self):
        status, body, _ = self.request("GET", "/api/supervisor/dashboard")
        self.assertEqual(status, 401)

        enumerator_cookie = self.login("ENUM001", "field-demo-2026")
        status, body, _ = self.request("GET", "/api/supervisor/dashboard", cookie=enumerator_cookie)
        self.assertEqual(status, 403)

        draft = {
            "interviewId": "INT-TEST-001",
            "enumerator": "SUPERVISOR",
            "respondent": "Test respondent",
            "startedAt": "2026-09-30T12:00:00Z",
            "answers": [{"id": "Q01", "response": "Test respondent", "status": "normal", "flags": []}],
        }
        status, body, _ = self.request("POST", "/api/interviews", draft, enumerator_cookie)
        self.assertEqual(status, 200, body)
        self.assertEqual(body["status"], "draft")

        status, body, _ = self.request("GET", "/api/interviews/drafts", cookie=enumerator_cookie)
        self.assertEqual(status, 200)
        self.assertEqual(body[0]["enumerator"], "ENUM001")

        draft["completedAt"] = "2026-09-30T12:05:00Z"
        draft["answers"] = [
            {"id": "Q01", "key": "name", "response": "Test respondent", "question_duration_seconds": 8, "flags": [{"category": "inconsistency", "message": "forged"}]},
            {"id": "Q02", "key": "age", "response": "24", "question_duration_seconds": 8},
            {"id": "Q03", "key": "occupation", "response": "Student", "question_duration_seconds": 8},
            {"id": "Q04", "key": "marital", "response": "Single", "question_duration_seconds": 8},
            {"id": "Q05", "key": "district", "response": "Provo", "question_duration_seconds": 8},
            {"id": "Q06", "key": "household", "response": "3", "question_duration_seconds": 8},
        ]
        status, body, _ = self.request("POST", "/api/interviews", draft, enumerator_cookie)
        self.assertEqual(status, 200, body)
        self.assertEqual(body["status"], "submitted")

        supervisor_cookie = self.login("SUPERVISOR", "monitor-demo-2026")
        status, body, _ = self.request("GET", "/api/supervisor/dashboard", cookie=supervisor_cookie)
        self.assertEqual(status, 200)
        self.assertEqual(len(body["interviews"]), 1)
        self.assertEqual(body["interviews"][0]["enumerator"], "ENUM001")
        self.assertEqual(body["interviews"][0]["status"], "submitted")
        self.assertEqual(body["interviews"][0]["answers"][0]["flags"], [])
        self.assertEqual(body["interviews"][0]["quality_summary"]["method"], "server-side questionnaire rules")
        self.assertEqual(body["model"]["status"], "active")
        self.assertTrue(body["model"]["model_source"])
        self.assertIn(body["interviews"][0]["model_assessment"]["status"], {"normal", "anomaly"})

        status, _, _ = self.request(
            "POST", "/api/supervisor/interviews/INT-TEST-001/review", cookie=enumerator_cookie
        )
        self.assertEqual(status, 403)
        status, review, _ = self.request(
            "POST", "/api/supervisor/interviews/INT-TEST-001/review", cookie=supervisor_cookie
        )
        self.assertEqual(status, 200)
        self.assertEqual(review["reviewedBy"], "SUPERVISOR")
        status, body, _ = self.request("GET", "/api/supervisor/dashboard", cookie=supervisor_cookie)
        self.assertEqual(status, 200)
        self.assertEqual(body["interviews"][0]["reviewedBy"], "SUPERVISOR")
        self.assertIn("review_interview", [event["action"] for event in body["audit"]])

    def test_supervisor_provisions_enumerator_and_password_rotation_revokes_access(self):
        supervisor_cookie = self.login("SUPERVISOR", "monitor-demo-2026")
        status, account, _ = self.request(
            "POST",
            "/api/supervisor/enumerators",
            {"username": "ENUM002", "temporary_password": "field-temp-2026"},
            supervisor_cookie,
        )
        self.assertEqual(status, 200, account)
        self.assertTrue(account["mustChangePassword"])

        enumerator_cookie = self.login("ENUM002", "field-temp-2026")
        status, _, _ = self.request("GET", "/api/interviews/drafts", cookie=enumerator_cookie)
        self.assertEqual(status, 403)

        status, changed, _ = self.request(
            "POST",
            "/api/auth/change-password",
            {"new_password": "new-private-password-2026"},
            enumerator_cookie,
        )
        self.assertEqual(status, 200, changed)
        self.assertFalse(changed["mustChangePassword"])
        status, drafts, _ = self.request("GET", "/api/interviews/drafts", cookie=enumerator_cookie)
        self.assertEqual(status, 200)
        self.assertEqual(drafts, [])

        status, _, _ = self.request(
            "PATCH", "/api/supervisor/enumerators/ENUM002", {"active": False}, supervisor_cookie
        )
        self.assertEqual(status, 200)
        status, _, _ = self.request("GET", "/api/auth/me", cookie=enumerator_cookie)
        self.assertEqual(status, 200)


if __name__ == "__main__":
    unittest.main()