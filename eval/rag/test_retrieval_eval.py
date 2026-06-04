import json
import tempfile
import unittest
from pathlib import Path

from eval.rag.run_retrieval_eval import load_cases, reciprocal_rank, render_summary, score_rankings


class RetrievalMetricTest(unittest.TestCase):
    def test_reciprocal_rank_uses_first_gold_hit(self):
        self.assertEqual(reciprocal_rank(["x", "gold", "y"], {"gold"}, cutoff=5), 0.5)

    def test_reciprocal_rank_is_zero_when_gold_is_beyond_cutoff(self):
        self.assertEqual(reciprocal_rank(["a", "b", "c", "d", "e", "gold"], {"gold"}, cutoff=5), 0.0)

    def test_score_rankings_computes_hit_and_mrr(self):
        rows, metrics = score_rankings(
            [
                {"id": "q1", "question": "one", "goldChunkIds": ["g1"]},
                {"id": "q2", "question": "two", "goldChunkIds": ["g2"]},
            ],
            {"q1": ["g1", "x"], "q2": ["x", "g2"]},
        )
        self.assertEqual(len(rows), 2)
        self.assertEqual(metrics, {"questions": 2, "hitAt1": 0.5, "hitAt5": 1.0, "mrrAt5": 0.75})

    def test_load_cases_rejects_unknown_gold_chunk(self):
        with tempfile.TemporaryDirectory() as directory:
            cases_path = Path(directory) / "cases.jsonl"
            cases_path.write_text(
                json.dumps(
                    {
                        "id": "q1",
                        "question": "question",
                        "goldChunkIds": ["missing"],
                        "goldPages": [1],
                        "category": "test",
                        "rationale": "reason",
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "unknown Gold Chunk"):
                load_cases(cases_path, {"p1-c1": 1}, expected_count=1)

    def test_summary_names_the_best_method_by_mrr(self):
        metrics = {
            "bm25": {"hitAt1": 0.5, "hitAt5": 0.8, "mrrAt5": 0.6},
            "dense": {"hitAt1": 0.4, "hitAt5": 0.7, "mrrAt5": 0.5},
            "hybrid": {"hitAt1": 0.3, "hitAt5": 0.8, "mrrAt5": 0.4},
        }
        summary = render_summary(metrics, {"chunkCount": 37, "model": "test-model"})
        self.assertIn("Best method by MRR@5: `bm25`", summary)


if __name__ == "__main__":
    unittest.main()
