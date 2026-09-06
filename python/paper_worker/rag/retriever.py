import hashlib
import json
from pathlib import Path
import faiss
import numpy as np
from .fusion import reciprocal_rank_fusion
from .keyword_store import KeywordStore
from .models import PaperChunk


class ManifestError(ValueError): pass


def _payload(chunks):
    return json.dumps([x.to_dict() for x in chunks], ensure_ascii=False, separators=(",", ":")).encode()


class HybridRetriever:
    def __init__(self, embedding):
        self.embedding, self.chunks, self.index = embedding, [], None

    @property
    def chunk_count(self): return len(self.chunks)

    def build(self, directory, chunks):
        if not chunks or len({x.paper_id for x in chunks}) != 1:
            raise ValueError("index must contain one paper")
        root = Path(directory); root.mkdir(parents=True, exist_ok=True)
        data = _payload(chunks); (root / "chunks.json").write_bytes(data)
        dense = False
        try:
            vectors = np.asarray(self.embedding.embed_documents([x.text for x in chunks]), dtype=np.float32)
            if vectors.shape != (len(chunks), self.embedding.dimension): raise ValueError("embedding shape mismatch")
            faiss.normalize_L2(vectors); self.index = faiss.IndexFlatIP(self.embedding.dimension); self.index.add(vectors)
            faiss.write_index(self.index, str(root / "faiss.index")); dense = True
        except Exception:
            (root / "faiss.index").unlink(missing_ok=True); self.index = None
        self.chunks = list(chunks)
        manifest = {"version": 1, "paperId": chunks[0].paper_id, "model": self.embedding.model_name,
                    "dimension": self.embedding.dimension, "chunkCount": len(chunks),
                    "chunksSha256": hashlib.sha256(data).hexdigest(), "denseAvailable": dense}
        (root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        return {"ok": True, "action": "build", "denseAvailable": dense}

    def load(self, directory, paper_id):
        root = Path(directory)
        try:
            data = (root / "chunks.json").read_bytes(); manifest = json.loads((root / "manifest.json").read_text("utf-8"))
            chunks = [PaperChunk.from_dict(x) for x in json.loads(data)]
        except Exception as exc: raise ManifestError("invalid manifest") from exc
        checks = {"version": 1, "paperId": paper_id, "chunkCount": len(chunks), "chunksSha256": hashlib.sha256(data).hexdigest()}
        if any(manifest.get(k) != v for k, v in checks.items()) or any(x.paper_id != paper_id for x in chunks):
            raise ManifestError("manifest mismatch")
        self.chunks = chunks
        if manifest.get("denseAvailable"):
            if manifest.get("model") != self.embedding.model_name:
                raise ManifestError("embedding configuration mismatch")
            self.index = faiss.read_index(str(root / "faiss.index"))
            if self.index.ntotal != len(chunks) or self.index.d != manifest.get("dimension"): raise ManifestError("index mismatch")
        return self

    def search(self, query, k=5):
        count = min(max(k * 2, k), len(self.chunks)); sparse = KeywordStore(self.chunks).search(query, count)
        rankings = [[x.chunk_id for x, _ in sparse]]
        if self.index is not None:
            try:
                vector = np.asarray([self.embedding.embed_query(query)], dtype=np.float32); faiss.normalize_L2(vector)
                _, ids = self.index.search(vector, count); rankings.insert(0, [self.chunks[i].chunk_id for i in ids[0] if i >= 0])
            except Exception: pass
        by_id = {x.chunk_id: x for x in self.chunks}
        return [(by_id[i], score) for i, score in reciprocal_rank_fusion(rankings)[:k]]
