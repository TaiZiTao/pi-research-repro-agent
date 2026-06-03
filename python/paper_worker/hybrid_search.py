#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
from rag.embedding import SentenceTransformerEmbedding
from rag.models import PaperChunk
from rag.retriever import HybridRetriever


def execute(req):
    paper_id = str(req.get("paperId", "")); action = req.get("action")
    if len(paper_id) != 64: raise ValueError("invalid paperId")
    embedding = SentenceTransformerEmbedding(req.get("model") or os.getenv("RESEARCH_EMBEDDING_MODEL", "intfloat/multilingual-e5-small"), os.getenv("RESEARCH_EMBEDDING_LOCAL_ONLY", "1") != "0")
    if action == "build":
        chunks = [PaperChunk.from_dict(x) for x in json.loads(Path(req["chunksPath"]).read_text("utf-8"))]
        return HybridRetriever(embedding).build(req["indexDir"], chunks)
    if action == "search":
        query = str(req.get("query", "")).strip(); k = int(req.get("k", 5))
        if not query or len(query) > 1000 or not 1 <= k <= 8: raise ValueError("invalid query")
        hits = HybridRetriever(embedding).load(req["indexDir"], paper_id).search(query, k)
        return {"ok": True, "action": "search", "hits": [{**x.to_dict(), "score": score} for x, score in hits]}
    raise ValueError("invalid action")


try:
    print(json.dumps(execute(json.loads(sys.argv[1])), ensure_ascii=False))
except Exception as exc:
    print(json.dumps({"ok": False, "error": type(exc).__name__})); raise SystemExit(1)
