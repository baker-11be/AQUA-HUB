from __future__ import annotations

import random
from pathlib import Path

import pandas as pd


random.seed(42)


def generate_questionnaire_data(output_path: str | Path = "data/raw/questionnaire_data.csv", n_interviews: int = 200, questions_per_interview: int = 20) -> pd.DataFrame:
    records = []
    for interview_id in range(1, n_interviews + 1):
        interviewer_id = f"INT-{interview_id % 25 + 1:03d}"
        base_response = 20 + (interview_id % 10) * 2
        anomaly = interview_id % 30 == 0

        for question_id in range(1, questions_per_interview + 1):
            response_time = max(5, random.gauss(base_response, 5 if not anomaly else 20))
            pause = 0 if random.random() > 0.85 else max(0, random.gauss(10 if not anomaly else 180, 8 if not anomaly else 60))
            start = pd.Timestamp("2025-01-01") + pd.Timedelta(days=interview_id, minutes=question_id * 5)
            end = start + pd.Timedelta(seconds=response_time)
            records.append(
                {
                    "interview_id": interview_id,
                    "interviewer_id": interviewer_id,
                    "question_id": question_id,
                    "question_start": start,
                    "question_end": end,
                    "response_time_seconds": round(response_time, 2),
                    "pause_seconds": round(pause, 2),
                    "question_text": f"Q{question_id}",
                }
            )

    df = pd.DataFrame(records)
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(output, index=False)
    return df


if __name__ == "__main__":
    generate_questionnaire_data()
    print("Synthetic questionnaire data generated.")
