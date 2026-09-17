from __future__ import annotations

import random
from pathlib import Path

import pandas as pd


random.seed(42)


def generate_questionnaire_data(output_path: str | Path = "data/raw/questionnaire_data.csv", n_interviews: int = 200, questions_per_interview: int = 20) -> pd.DataFrame:
    records = []
    question_prompts = {
        1: "What is your name?",
        2: "How old are you?",
        3: "What is your main occupation?",
        4: "What is your marital status?",
        5: "Which district do you live in?",
        6: "How many people live in your household?",
    }
    question_rubrics = {
        1: "Respondent name should be entered as text only.",
        2: "Age must be a numeric value in years.",
        3: "Occupation should match a valid category such as Farming, Business, Student, or Other.",
        4: "Marital status should be one of the allowed categories.",
        5: "District should be the name of a place, not a number.",
        6: "Household size should be a whole number.",
    }
    response_values = {
        1: "Green Yellow 1",
        2: "25",
        3: "Farming",
        4: "Married",
        5: "Wakiso",
        6: "6",
    }

    for interview_id in range(1, n_interviews + 1):
        interviewer_id = f"INT-{interview_id % 25 + 1:03d}"
        base_response = 20 + (interview_id % 10) * 2
        anomaly = interview_id % 30 == 0

        for question_id in range(1, questions_per_interview + 1):
            response_time = max(5, random.gauss(base_response, 5 if not anomaly else 20))
            pause = 0 if random.random() > 0.85 else max(0, random.gauss(10 if not anomaly else 180, 8 if not anomaly else 60))
            start = pd.Timestamp("2025-01-01") + pd.Timedelta(days=interview_id, minutes=question_id * 5)
            end = start + pd.Timedelta(seconds=response_time)
            response = response_values.get(question_id % 6 or 6, "Unknown")
            duplicate_flag = (question_id % 4 == 0) and (interview_id % 3 == 0)
            response_status = "flagged" if duplicate_flag or anomaly else "completed"
            audio_text = f"Voice transcript: {response}"
            summary = (
                f"Duplicates: {int(duplicate_flag)} | Pause: {round(pause, 2)}s | "
                f"Start: {start.isoformat()} | End: {end.isoformat()}"
            )
            records.append(
                {
                    "interview_id": interview_id,
                    "interviewer_id": interviewer_id,
                    "question_id": question_id,
                    "question_start": start,
                    "question_end": end,
                    "response_time_seconds": round(response_time, 2),
                    "pause_seconds": round(pause, 2),
                    "question_text": question_prompts.get(question_id, f"Q{question_id}"),
                    "response": response,
                    "response_status": response_status,
                    "rubric": question_rubrics.get(question_id, "Follow the assigned questionnaire rule."),
                    "voice_text": audio_text,
                    "duplicate_flag": duplicate_flag,
                    "summary": summary,
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
