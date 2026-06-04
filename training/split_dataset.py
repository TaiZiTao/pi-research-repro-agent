"""Create a leakage-checked training split against fixed evaluation prompts."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import unicodedata
from pathlib import Path
from typing import Any


def normalize_prompt(text: str) -> str:
    normalized = unicodedata.normalize("NFKC", text).casefold()
    return re.sub(r"[^0-9a-z\u4e00-\u9fff]+", "", normalized)


def split_training_records(
    records: list[dict[str, Any]], evaluation_cases: list[dict[str, Any]]
) -> tuple[list[dict[str, Any]], list[str]]:
    evaluation_prompts = {
        normalize_prompt(case.get("prompt", ""))
        for case in evaluation_cases
        if normalize_prompt(case.get("prompt", ""))
    }
    kept: list[dict[str, Any]] = []
    excluded: list[str] = []
    for record in records:
        user_prompts = {
            normalize_prompt(message.get("content", ""))
            for message in record.get("messages", [])
            if message.get("role") == "user"
        }
        if user_prompts & evaluation_prompts:
            excluded.append(record["id"])
        else:
            kept.append(record)
    return kept, excluded


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=Path("training/data/raw/golden.jsonl"))
    parser.add_argument("--validation", type=Path, default=Path("eval/cases_validation.json"))
    parser.add_argument("--holdout", type=Path, default=Path("eval/cases_holdout.json"))
    parser.add_argument("--output", type=Path, default=Path("training/data/splits/train.jsonl"))
    parser.add_argument("--manifest", type=Path, default=Path("training/data/splits/manifest.json"))
    args = parser.parse_args()

    source = _read_jsonl(args.source)
    validation = json.loads(args.validation.read_text(encoding="utf-8"))
    holdout = json.loads(args.holdout.read_text(encoding="utf-8"))
    kept, excluded = split_training_records(source, [*validation, *holdout])

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        "".join(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n" for record in kept),
        encoding="utf-8",
    )
    manifest = {
        "source": str(args.source),
        "source_count": len(source),
        "train_count": len(kept),
        "validation_count": len(validation),
        "holdout_count": len(holdout),
        "excluded_exact_prompt_overlap": excluded,
        "validation_sha256": _sha256(args.validation),
        "holdout_sha256": _sha256(args.holdout),
    }
    args.manifest.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, ensure_ascii=False))


if __name__ == "__main__":
    main()
