"""Validate a research-agent JSONL dataset and reject duplicate trajectory IDs."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from training.schema import validate_trajectory


def validate_file(path: Path) -> tuple[int, list[str]]:
    errors: list[str] = []
    ids: set[str] = set()
    count = 0
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        count += 1
        try:
            record = json.loads(line)
        except json.JSONDecodeError as error:
            errors.append(f"line {line_number}: invalid JSON: {error.msg}")
            continue
        record_id = record.get("id") if isinstance(record, dict) else None
        if isinstance(record_id, str) and record_id in ids:
            errors.append(f"line {line_number}: duplicate id {record_id}")
        elif isinstance(record_id, str):
            ids.add(record_id)
        errors.extend(f"line {line_number}: {error}" for error in validate_trajectory(record))
    return count, errors


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("dataset", type=Path)
    args = parser.parse_args()
    count, errors = validate_file(args.dataset)
    print(json.dumps({"records": count, "valid": not errors, "errors": errors}, ensure_ascii=False))
    raise SystemExit(1 if errors else 0)


if __name__ == "__main__":
    main()

