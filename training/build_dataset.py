"""Build sanitized JSONL from reviewed scenario JSON files."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from training.schema import sanitize_trajectory, validate_trajectory


def build_dataset(scenarios_dir: Path, output_path: Path) -> int:
    records: list[dict] = []
    for source_path in sorted(scenarios_dir.glob("*.json")):
        record = sanitize_trajectory(json.loads(source_path.read_text(encoding="utf-8")))
        errors = validate_trajectory(record)
        if errors:
            raise ValueError(f"{source_path.name}: " + "; ".join(errors))
        records.append(record)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        "".join(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n" for record in records),
        encoding="utf-8",
    )
    return len(records)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--scenarios", type=Path, default=Path("training/scenarios"))
    parser.add_argument("--output", type=Path, default=Path("training/data/raw/golden.jsonl"))
    args = parser.parse_args()
    count = build_dataset(args.scenarios, args.output)
    print(json.dumps({"records": count, "output": str(args.output)}, ensure_ascii=False))


if __name__ == "__main__":
    main()

