import json
import unittest

from training.schema import sanitize_trajectory, validate_trajectory


class DatasetPipelineTest(unittest.TestCase):
    def test_sanitizes_and_validates_tool_trajectory(self):
        trajectory = {
            "id": "golden-001",
            "scenario": "reproduction_error_repair",
            "source": "real",
            "tools": [{"name": "research_reproduction_execute"}],
            "messages": [
                {"role": "user", "content": "复现论文"},
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "call-1",
                            "type": "function",
                            "function": {
                                "name": "research_reproduction_execute",
                                "arguments": {"action": "next-step"},
                            },
                        }
                    ],
                },
                {
                    "role": "tool",
                    "tool_call_id": "call-1",
                    "name": "research_reproduction_execute",
                    "content": json.dumps(
                        {"error": "failed in C:\\Users\\17093\\secret with ghp_supersecret"},
                        ensure_ascii=False,
                    ),
                },
                {"role": "assistant", "content": "执行失败，需要修复。"},
            ],
        }

        sanitized = sanitize_trajectory(trajectory)
        serialized = json.dumps(sanitized, ensure_ascii=False)
        self.assertNotIn("17093", serialized)
        self.assertNotIn("ghp_supersecret", serialized)
        self.assertEqual(validate_trajectory(sanitized), [])

        sanitized["messages"][1]["tool_calls"][0]["function"]["name"] = "missing_tool"
        self.assertTrue(any("missing_tool" in error for error in validate_trajectory(sanitized)))


if __name__ == "__main__":
    unittest.main()
