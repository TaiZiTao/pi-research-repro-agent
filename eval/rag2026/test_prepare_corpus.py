import tempfile
import unittest
from pathlib import Path

from eval.rag2026.prepare_corpus import EMBEDDING_MODEL, PAPERS, validate_dense_manifest


class PrepareCorpusTest(unittest.TestCase):
    def test_fixed_corpus_contains_five_distinct_papers(self):
        self.assertEqual(len(PAPERS), 5)
        self.assertEqual(len(set(PAPERS)), 5)

    def test_dense_manifest_requires_matching_model_and_faiss_file(self):
        with tempfile.TemporaryDirectory() as directory:
            evidence_dir = Path(directory)
            valid = {
                "denseAvailable": True,
                "model": EMBEDDING_MODEL,
                "chunkCount": 12,
            }
            with self.assertRaisesRegex(ValueError, "faiss.index"):
                validate_dense_manifest(valid, evidence_dir)

            (evidence_dir / "faiss.index").write_bytes(b"index")
            validate_dense_manifest(valid, evidence_dir)

            unavailable = {**valid, "denseAvailable": False}
            with self.assertRaisesRegex(ValueError, "Dense index"):
                validate_dense_manifest(unavailable, evidence_dir)


if __name__ == "__main__":
    unittest.main()
