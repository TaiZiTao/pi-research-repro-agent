import json
import tempfile
import unittest
from pathlib import Path

import numpy as np

from python.paper_worker.rag.embedding import BaseEmbedding
from python.paper_worker.rag.fusion import reciprocal_rank_fusion
from python.paper_worker.rag.keyword_store import tokenize
from python.paper_worker.rag.models import PaperChunk
from python.paper_worker.rag.retriever import HybridRetriever, ManifestError


class FakeEmbedding(BaseEmbedding):
    model_name = "fake-test"
    dimension = 2

    def embed_documents(self, texts):
        return [[1.0, 0.0] if "method" in text.lower() else [0.0, 1.0] for text in texts]

    def embed_query(self, text):
        return [1.0, 0.0]


class FailingEmbedding(FakeEmbedding):
    def embed_documents(self, texts):
        raise RuntimeError("model unavailable at secret path")

    def embed_query(self, text):
        raise RuntimeError("query embedding failed")


def chunks(paper_id="a" * 64):
    return [
        PaperChunk(paper_id, "p1-c1", 1, "Ablation method details"),
        PaperChunk(paper_id, "p2-c1", 2, "中文证据 and evaluation"),
    ]


class RagTest(unittest.TestCase):
    def test_bilingual_tokenizer_and_rrf_are_deterministic(self):
        self.assertEqual(tokenize("Hello, 世界 BGE-2!"), ["hello", "世", "界", "bge", "2"])
        ranked = reciprocal_rank_fusion([["b", "a"], ["a", "b"]])
        self.assertEqual([item for item, _ in ranked], ["a", "b"])

    def test_persistence_is_json_faiss_only_and_manifest_isolates_papers(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            retriever = HybridRetriever(FakeEmbedding())
            status = retriever.build(root, chunks())
            self.assertTrue(status["denseAvailable"])
            self.assertEqual({p.name for p in root.iterdir()}, {"chunks.json", "faiss.index", "manifest.json"})
            self.assertFalse(list(root.glob("*.pkl")))
            manifest = json.loads((root / "manifest.json").read_text("utf-8"))
            self.assertEqual(manifest["dimension"], 2)
            loaded = HybridRetriever(FakeEmbedding()).load(root, "a" * 64)
            self.assertEqual(loaded.chunk_count, 2)
            with self.assertRaises(ValueError):
                HybridRetriever(FakeEmbedding()).build(root, chunks() + chunks("b" * 64))
            manifest = json.loads((root / "manifest.json").read_text("utf-8"))
            manifest["chunkCount"] = 99
            (root / "manifest.json").write_text(json.dumps(manifest), "utf-8")
            with self.assertRaises(ManifestError):
                HybridRetriever(FakeEmbedding()).load(root, "a" * 64)

    def test_dense_build_and_query_failures_degrade_to_sparse(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            status = HybridRetriever(FailingEmbedding()).build(root, chunks())
            self.assertFalse(status["denseAvailable"])
            hits = HybridRetriever(FailingEmbedding()).load(root, "a" * 64).search("证据", 3)
            self.assertEqual(hits[0][0].chunk_id, "p2-c1")

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            HybridRetriever(FakeEmbedding()).build(root, chunks())
            hits = HybridRetriever(FailingEmbedding()).load(root, "a" * 64).search("method", 3)
            self.assertEqual(hits[0][0].chunk_id, "p1-c1")


if __name__ == "__main__":
    unittest.main()
