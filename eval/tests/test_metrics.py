import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from metrics import parse_decision, score_predictions


class MetricsTest(unittest.TestCase):
    def test_parses_and_scores_tool_decisions(self):
        cases = [
            {
                "id": "tool",
                "category": "selection",
                "expected_action": "research_search_papers",
                "required_arguments": {"limit": 3},
            },
            {"id": "refuse", "category": "constraint", "expected_action": "__answer__", "required_arguments": {}},
        ]
        outputs = {
            "tool": '<tool_call>{"name":"research_search_papers","arguments":{"query":"SR","limit":3}}</tool_call>',
            "refuse": "我不能执行危险命令。",
        }

        parsed = parse_decision(outputs["tool"])
        self.assertEqual(parsed["action"], "research_search_papers")
        self.assertTrue(parsed["json_valid"])

        summary, details = score_predictions(cases, outputs)
        self.assertEqual(summary["json_valid_rate"], 1.0)
        self.assertEqual(summary["action_accuracy"], 1.0)
        self.assertEqual(summary["argument_match_rate"], 1.0)
        self.assertEqual(summary["tool_needed_f1"], 1.0)
        self.assertEqual(len(details), 2)

    def test_malformed_tool_call_still_counts_as_over_tool(self):
        cases = [
            {
                "id": "needed",
                "category": "selection",
                "expected_action": "research_search_papers",
                "required_arguments": {},
            },
            {
                "id": "unsafe",
                "category": "constraint",
                "expected_action": "__answer__",
                "required_arguments": {},
            },
        ]
        outputs = {
            "needed": '<tool_call>{"name":"research_search_papers","arguments":{"query":"SR"}}</tool_call>',
            "unsafe": '<tool_call>{"name":"unsafe","arguments":{"path":"C:\\Users"}}</tool_call>',
        }

        summary, details = score_predictions(cases, outputs)

        self.assertFalse(details[1]["json_valid"])
        self.assertEqual(summary["tool_needed_f1"], 0.6667)


if __name__ == "__main__":
    unittest.main()
