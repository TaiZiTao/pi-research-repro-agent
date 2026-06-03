"""Report the next-action distribution after prepare_sft expansion."""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path

from prepare_sft import build_examples


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("dataset", type=Path, default=Path("training/data/raw/golden.jsonl"), nargs="?")
    args = parser.parse_args()
    trajectories = 0
    scenarios = Counter()
    actions = Counter()
    for line in args.dataset.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        record = json.loads(line)
        trajectories += 1
        scenarios[record.get("scenario", "?")] += 1
        for example in build_examples(record):
            actions[example["target_action"]] += 1
    report = {
        "trajectory_count": trajectories,
        "scenario_distribution": dict(sorted(scenarios.items())),
        "example_count": sum(actions.values()),
        "target_action_distribution": dict(sorted(actions.items())),
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
