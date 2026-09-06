import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from prepare_sft import TOOL_DESCRIPTIONS, build_examples


class PrepareSftTest(unittest.TestCase):
    def test_builds_one_example_per_assistant_decision(self):
        trajectory = {
            "id": "case-1",
            "tools": [{"name": "research_search_evidence"}],
            "messages": [
                {"role": "user", "content": "论文指标是什么？"},
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "call-1",
                            "type": "function",
                            "function": {
                                "name": "research_search_evidence",
                                "arguments": {"query": "论文指标"},
                            },
                        }
                    ],
                },
                {
                    "role": "tool",
                    "tool_call_id": "call-1",
                    "name": "research_search_evidence",
                    "content": '{"hits":[]}',
                },
                {"role": "assistant", "content": "证据不足，无法回答。"},
            ],
        }

        examples = build_examples(trajectory)

        self.assertEqual(len(examples), 2)
        self.assertEqual(examples[0]["target_action"], "research_search_evidence")
        self.assertIn("<tool_call>", examples[0]["completion"])
        self.assertEqual(len(examples[0]["tools"]), len(TOOL_DESCRIPTIONS))
        self.assertIn(
            "research_plan_reproduction",
            {tool["function"]["name"] for tool in examples[0]["tools"]},
        )
        self.assertEqual(examples[1]["target_action"], "__answer__")
        self.assertIn("证据不足", examples[1]["completion"])


if __name__ == "__main__":
    unittest.main()
