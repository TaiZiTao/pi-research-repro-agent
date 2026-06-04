import unittest

from eval.rag2026.run_chinese_eval import (
    score_rankings,
    validate_dataset_shape,
    validate_gold,
    validate_question,
)
from python.paper_worker.rag.models import PaperChunk


class ChineseEvalTest(unittest.TestCase):
    def test_metrics_include_hit_at_1_3_5_and_mrr_at_5(self):
        cases = [
            {"id": "q1", "goldChunkIds": ["g1"]},
            {"id": "q2", "goldChunkIds": ["g2"]},
            {"id": "q3", "goldChunkIds": ["g3"]},
        ]
        rankings = {"q1": ["g1"], "q2": ["x", "y", "g2"], "q3": ["x", "y", "z"]}
        _, metrics = score_rankings(cases, rankings)
        self.assertAlmostEqual(metrics["hitAt1"], 1 / 3)
        self.assertAlmostEqual(metrics["hitAt3"], 2 / 3)
        self.assertAlmostEqual(metrics["hitAt5"], 2 / 3)
        self.assertAlmostEqual(metrics["mrrAt5"], (1 + 1 / 3) / 3)

    def test_dataset_requires_exactly_twenty_cases(self):
        with self.assertRaisesRegex(ValueError, "20 cases"):
            validate_dataset_shape([])

    def test_dataset_requires_four_categories_per_paper(self):
        cases = []
        for paper_index in range(5):
            for question_index in range(4):
                cases.append(
                    {
                        "id": f"p{paper_index}-q{question_index}",
                        "paper": f"paper-{paper_index}.pdf",
                        "category": "architecture",
                        "question": f"这个问题包含中文{paper_index}{question_index}",
                    }
                )
        with self.assertRaisesRegex(ValueError, "four categories"):
            validate_dataset_shape(cases)

    def test_dataset_rejects_non_chinese_question(self):
        with self.assertRaisesRegex(ValueError, "Chinese question"):
            validate_question("What optimizer is used?")

    def test_gold_evidence_must_match_index(self):
        chunks = {"p2-c1": PaperChunk("paper", "p2-c1", 2, "Adam optimizer is used.")}
        case = {
            "goldChunkIds": ["p2-c1"],
            "goldPages": [2],
            "evidenceText": "text absent from the Gold Chunk",
        }
        with self.assertRaisesRegex(ValueError, "evidenceText"):
            validate_gold(case, chunks)


if __name__ == "__main__":
    unittest.main()
