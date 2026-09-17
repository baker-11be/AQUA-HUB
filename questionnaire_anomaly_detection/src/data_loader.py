from __future__ import annotations

from pathlib import Path
from typing import Union

import pandas as pd


REQUIRED_COLUMNS = {
    "interview_id",
    "interviewer_id",
    "question_id",
    "question_start",
    "question_end",
    "response_time_seconds",
    "pause_seconds",
    "question_text",
}
OPTIONAL_COLUMNS = {
    "response",
    "response_status",
    "rubric",
    "voice_text",
    "duplicate_flag",
    "summary",
}


def load_questionnaire_data(csv_path: Union[str, Path]) -> pd.DataFrame:
    """Load source questionnaire paradata from a CSV file."""
    path = Path(csv_path)
    df = pd.read_csv(path)

    missing_columns = REQUIRED_COLUMNS - set(df.columns)
    if missing_columns:
        raise ValueError(
            f"CSV file is missing required columns: {sorted(missing_columns)}"
        )

    for column in sorted(OPTIONAL_COLUMNS - set(df.columns)):
        df[column] = ""

    return df
