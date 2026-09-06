import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from generate_golden import generate_synthetic_trajectories
from split_dataset import split_training_records
from train_lora import load_examples


def _trajectory(identifier: str, prompt: str, action: str = "__answer__") -> dict:
    assistant = {"role": "assistant", "content": "直接回答"}
    tools = [{"name": "research_search_evidence"}]
    if action != "__answer__":
        assistant = {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {
                    "id": f"call-{identifier}",
                    "type": "function",
                    "function": {"name": action, "arguments": {"query": prompt}},
                }
            ],
        }
    return {
        "id": identifier,
        "scenario": "test",
        "source": "synthetic",
        "tools": tools,
        "messages": [{"role": "user", "content": prompt}, assistant],
    }


class SplitAndSamplingTest(unittest.TestCase):
    def test_fractional_answer_multiplier_is_deterministic(self):
        rows = [
            _trajectory("a1", "回答一"),
            _trajectory("a2", "回答二"),
            _trajectory("a3", "回答三"),
            _trajectory("a4", "回答四"),
            _trajectory("t1", "检索一", "research_search_evidence"),
            _trajectory("t2", "检索二", "research_search_evidence"),
        ]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "data.jsonl"
            path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")
            first = load_examples(path, answer_multiplier=1.5, seed=7)
            second = load_examples(path, answer_multiplier=1.5, seed=7)

        self.assertEqual(len(first), 8)
        self.assertEqual(
            [example["trajectory_id"] for example in first],
            [example["trajectory_id"] for example in second],
        )

    def test_split_excludes_training_prompt_found_in_validation(self):
        records = [_trajectory("duplicate", "相同问题"), _trajectory("kept", "仅训练问题")]
        validation = [{"id": "val-1", "prompt": "相同问题"}]

        kept, excluded = split_training_records(records, validation)

        self.assertEqual([record["id"] for record in kept], ["kept"])
        self.assertEqual(excluded, ["duplicate"])

    def test_search_paper_limits_cover_requested_values(self):
        limits = {
            call["function"]["arguments"]["limit"]
            for record in generate_synthetic_trajectories()
            for message in record["messages"]
            for call in message.get("tool_calls", [])
            if call["function"]["name"] == "research_search_papers"
        }

        self.assertEqual(limits, {2, 3, 4, 5})


if __name__ == "__main__":
    unittest.main()
