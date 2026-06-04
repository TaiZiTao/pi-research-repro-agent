#!/usr/bin/env python3
import argparse
import json
import sys
from pathlib import Path

import faiss
import numpy as np


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
if str(REPOSITORY_ROOT) not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT))

from python.paper_worker.rag.embedding import SentenceTransformerEmbedding
from python.paper_worker.rag.fusion import reciprocal_rank_fusion
from python.paper_worker.rag.keyword_store import KeywordStore
from python.paper_worker.rag.models import PaperChunk
from python.paper_worker.rag.retriever import HybridRetriever


def reciprocal_rank(ranking, gold_chunk_ids, cutoff=5):
    for rank, chunk_id in enumerate(ranking[:cutoff], 1):
        if chunk_id in gold_chunk_ids:
            return 1.0 / rank
    return 0.0


def score_rankings(cases, rankings):
    rows = []
    for case in cases:
        ranking = rankings[case["id"]]
        gold = set(case["goldChunkIds"])
        rr = reciprocal_rank(ranking, gold, cutoff=5)
        rows.append(
            {
                "id": case["id"],
                "question": case["question"],
                "category": case.get("category"),
                "goldChunkIds": case["goldChunkIds"],
                "ranking": ranking[:5],
                "firstGoldRank": None if rr == 0 else round(1.0 / rr),
                "hitAt1": bool(ranking and ranking[0] in gold),
                "hitAt5": rr > 0,
                "reciprocalRankAt5": rr,
            }
        )
    count = len(rows)
    if count == 0:
        raise ValueError("evaluation set must not be empty")
    metrics = {
        "questions": count,
        "hitAt1": sum(row["hitAt1"] for row in rows) / count,
        "hitAt5": sum(row["hitAt5"] for row in rows) / count,
        "mrrAt5": sum(row["reciprocalRankAt5"] for row in rows) / count,
    }
    return rows, metrics


def load_chunks(index_dir):
    payload = json.loads((index_dir / "chunks.json").read_text(encoding="utf-8"))
    chunks = [PaperChunk.from_dict(item) for item in payload]
    if not chunks:
        raise ValueError("index contains no chunks")
    return chunks


def load_cases(cases_path, chunk_pages, expected_count=None):
    cases = []
    seen_ids = set()
    for line_number, raw_line in enumerate(cases_path.read_text(encoding="utf-8-sig").splitlines(), 1):
        if not raw_line.strip():
            continue
        try:
            case = json.loads(raw_line)
        except json.JSONDecodeError as error:
            raise ValueError(f"invalid JSON on line {line_number}") from error
        case_id = case.get("id")
        question = case.get("question")
        gold_ids = case.get("goldChunkIds")
        gold_pages = case.get("goldPages")
        if not isinstance(case_id, str) or not case_id or case_id in seen_ids:
            raise ValueError(f"invalid or duplicate case ID on line {line_number}")
        if not isinstance(question, str) or not question.strip():
            raise ValueError(f"empty question for {case_id}")
        if not isinstance(gold_ids, list) or not gold_ids or not all(isinstance(item, str) for item in gold_ids):
            raise ValueError(f"invalid Gold Chunks for {case_id}")
        unknown = [chunk_id for chunk_id in gold_ids if chunk_id not in chunk_pages]
        if unknown:
            raise ValueError(f"unknown Gold Chunk for {case_id}: {unknown[0]}")
        actual_pages = sorted({chunk_pages[chunk_id] for chunk_id in gold_ids})
        if not isinstance(gold_pages, list) or sorted(set(gold_pages)) != actual_pages:
            raise ValueError(f"Gold page mismatch for {case_id}")
        seen_ids.add(case_id)
        cases.append(case)
    if expected_count is not None and len(cases) != expected_count:
        raise ValueError(f"expected {expected_count} cases, found {len(cases)}")
    return cases


def build_rankings(cases, index_dir, chunks, manifest):
    if manifest.get("denseAvailable") is not True:
        raise ValueError("dense index is unavailable")
    paper_id = manifest.get("paperId")
    model_name = manifest.get("model")
    if not isinstance(paper_id, str) or not isinstance(model_name, str):
        raise ValueError("invalid index manifest")

    embedding = SentenceTransformerEmbedding(model_name, local_files_only=True)
    hybrid = HybridRetriever(embedding).load(index_dir, paper_id)
    dense_index = faiss.read_index(str(index_dir / "faiss.index"))
    sparse_index = KeywordStore(chunks)
    rankings = {"bm25": {}, "dense": {}, "hybrid": {}}
    candidate_count = min(10, len(chunks))

    for case in cases:
        query = case["question"]
        sparse_ids = [chunk.chunk_id for chunk, _ in sparse_index.search(query, candidate_count)]
        vector = np.asarray([embedding.embed_query(query)], dtype=np.float32)
        faiss.normalize_L2(vector)
        _, dense_indices = dense_index.search(vector, candidate_count)
        dense_ids = [chunks[index].chunk_id for index in dense_indices[0] if index >= 0]
        hybrid_ids = [chunk_id for chunk_id, _ in reciprocal_rank_fusion([dense_ids, sparse_ids])]
        project_hybrid_ids = [chunk.chunk_id for chunk, _ in hybrid.search(query, 5)]
        if hybrid_ids[:5] != project_hybrid_ids:
            raise ValueError(f"hybrid parity mismatch for {case['id']}")
        rankings["bm25"][case["id"]] = sparse_ids[:5]
        rankings["dense"][case["id"]] = dense_ids[:5]
        rankings["hybrid"][case["id"]] = project_hybrid_ids
    return rankings


def render_summary(metrics, manifest):
    lines = [
        "# DSPFM RAG Retrieval Evaluation",
        "",
        f"- Questions: 36 manually labeled",
        f"- Corpus: {manifest['chunkCount']} chunks",
        f"- Dense model: `{manifest['model']}`",
        "- Cutoff: 5",
        "",
        "| Method | Hit@1 | Hit@5 | MRR@5 |",
        "| --- | ---: | ---: | ---: |",
    ]
    for method in ("bm25", "dense", "hybrid"):
        item = metrics[method]
        lines.append(
            f"| {method} | {item['hitAt1'] * 100:.1f}% | {item['hitAt5'] * 100:.1f}% | {item['mrrAt5']:.3f} |"
        )
    return "\n".join(lines) + "\n"


def run(cases_path, index_dir, output_dir):
    chunks = load_chunks(index_dir)
    manifest = json.loads((index_dir / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("chunkCount") != len(chunks):
        raise ValueError("manifest chunk count mismatch")
    chunk_pages = {chunk.chunk_id: chunk.page for chunk in chunks}
    cases = load_cases(cases_path, chunk_pages, expected_count=36)
    rankings = build_rankings(cases, index_dir, chunks, manifest)
    method_results = {}
    metrics = {}
    for method, method_rankings in rankings.items():
        rows, method_metrics = score_rankings(cases, method_rankings)
        method_results[method] = rows
        metrics[method] = method_metrics
    payload = {"manifest": manifest, "metrics": metrics, "results": method_results}
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "retrieval-results.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    (output_dir / "summary.md").write_text(render_summary(metrics, manifest), encoding="utf-8")
    return payload


def main():
    parser = argparse.ArgumentParser(description="Evaluate BM25, Dense, and Hybrid retrieval on frozen DSPFM cases.")
    parser.add_argument("--cases", type=Path, required=True)
    parser.add_argument("--index", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    payload = run(args.cases.resolve(), args.index.resolve(), args.output.resolve())
    print(json.dumps(payload["metrics"], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
