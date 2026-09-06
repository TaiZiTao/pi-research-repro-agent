#!/usr/bin/env python3
import argparse
import hashlib
import json
import re
import sys
from collections import Counter, defaultdict
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


CATEGORIES = {"architecture", "module", "training", "results"}
CJK_PATTERN = re.compile(r"[\u3400-\u9fff]")


def normalize_text(value: str) -> str:
    return " ".join(value.lower().split())


def validate_question(question: object) -> None:
    if not isinstance(question, str) or not question.strip() or CJK_PATTERN.search(question) is None:
        raise ValueError("each case must contain a natural Chinese question")


def validate_dataset_shape(cases: list[dict]) -> None:
    if len(cases) != 20:
        raise ValueError(f"expected exactly 20 cases, found {len(cases)}")
    ids = [case.get("id") for case in cases]
    questions = [case.get("question") for case in cases]
    if any(not isinstance(case_id, str) or not case_id.strip() for case_id in ids) or len(set(ids)) != len(ids):
        raise ValueError("case IDs must be nonempty and unique")
    if len(set(questions)) != len(questions):
        raise ValueError("questions must be unique")
    for question in questions:
        validate_question(question)

    grouped: dict[str, list[dict]] = defaultdict(list)
    for case in cases:
        paper = case.get("paper")
        if not isinstance(paper, str) or not paper.endswith(".pdf"):
            raise ValueError("each case must name a PDF paper")
        grouped[paper].append(case)
    if len(grouped) != 5 or any(len(items) != 4 for items in grouped.values()):
        raise ValueError("dataset must contain five papers with four cases each")
    for paper, items in grouped.items():
        categories = [item.get("category") for item in items]
        if set(categories) != CATEGORIES or len(categories) != len(CATEGORIES):
            raise ValueError(f"paper must cover the four categories exactly once: {paper}")


def validate_gold(case: dict, chunks_by_id: dict[str, PaperChunk]) -> None:
    gold_ids = case.get("goldChunkIds")
    gold_pages = case.get("goldPages")
    evidence_text = case.get("evidenceText")
    note = case.get("annotationNote")
    if not isinstance(gold_ids, list) or not gold_ids or not all(isinstance(item, str) for item in gold_ids):
        raise ValueError("goldChunkIds must be a nonempty string list")
    if len(set(gold_ids)) != len(gold_ids):
        raise ValueError("goldChunkIds must not contain duplicates")
    unknown = [chunk_id for chunk_id in gold_ids if chunk_id not in chunks_by_id]
    if unknown:
        raise ValueError(f"unknown Gold Chunk: {unknown[0]}")
    actual_pages = sorted({chunks_by_id[chunk_id].page for chunk_id in gold_ids})
    if not isinstance(gold_pages, list) or sorted(set(gold_pages)) != actual_pages:
        raise ValueError("goldPages do not match Gold Chunk pages")
    if not isinstance(evidence_text, str) or len(evidence_text.strip()) < 12:
        raise ValueError("evidenceText must be a meaningful excerpt")
    normalized_evidence = normalize_text(evidence_text)
    if not any(normalized_evidence in normalize_text(chunks_by_id[chunk_id].text) for chunk_id in gold_ids):
        raise ValueError("evidenceText is absent from every Gold Chunk")
    if not isinstance(note, str) or len(note.strip()) < 8:
        raise ValueError("annotationNote must explain the Gold evidence")


def load_chunks(evidence_dir: Path) -> tuple[list[PaperChunk], dict]:
    manifest = json.loads((evidence_dir / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("denseAvailable") is not True or not (evidence_dir / "faiss.index").is_file():
        raise ValueError(f"Dense index is unavailable: {evidence_dir}")
    chunks = [
        PaperChunk.from_dict(item)
        for item in json.loads((evidence_dir / "chunks.json").read_text(encoding="utf-8"))
    ]
    if manifest.get("chunkCount") != len(chunks) or not chunks:
        raise ValueError(f"invalid Chunk manifest: {evidence_dir}")
    return chunks, manifest


def load_corpus(path: Path) -> dict[str, dict]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    rows = payload.get("papers")
    if not isinstance(rows, list) or len(rows) != 5:
        raise ValueError("corpus manifest must contain five papers")
    result = {}
    for row in rows:
        paper = row.get("paper")
        if not isinstance(paper, str) or paper in result:
            raise ValueError("corpus paper names must be unique")
        evidence_dir = Path(row["evidenceDir"])
        chunks, manifest = load_chunks(evidence_dir)
        if manifest.get("model") != payload.get("embeddingModel"):
            raise ValueError(f"embedding model mismatch for {paper}")
        result[paper] = {**row, "evidenceDir": evidence_dir, "chunks": chunks, "indexManifest": manifest}
    return result


def load_cases(path: Path, corpus: dict[str, dict]) -> list[dict]:
    cases = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8-sig").splitlines(), 1):
        if not line.strip():
            continue
        try:
            cases.append(json.loads(line))
        except json.JSONDecodeError as error:
            raise ValueError(f"invalid JSON on line {line_number}") from error
    validate_dataset_shape(cases)
    for case in cases:
        paper = case["paper"]
        if paper not in corpus:
            raise ValueError(f"paper is absent from corpus manifest: {paper}")
        chunks_by_id = {chunk.chunk_id: chunk for chunk in corpus[paper]["chunks"]}
        validate_gold(case, chunks_by_id)
    return cases


def score_rankings(cases: list[dict], rankings: dict[str, list[str]]) -> tuple[list[dict], dict]:
    rows = []
    for case in cases:
        ranking = rankings[case["id"]][:5]
        gold = set(case["goldChunkIds"])
        first_rank = next((rank for rank, chunk_id in enumerate(ranking, 1) if chunk_id in gold), None)
        rows.append(
            {
                "id": case["id"],
                "paper": case.get("paper"),
                "category": case.get("category"),
                "question": case.get("question"),
                "goldChunkIds": case["goldChunkIds"],
                "goldPages": case.get("goldPages"),
                "ranking": ranking,
                "firstGoldRank": first_rank,
                "hitAt1": first_rank == 1,
                "hitAt3": first_rank is not None and first_rank <= 3,
                "hitAt5": first_rank is not None and first_rank <= 5,
                "reciprocalRankAt5": 0.0 if first_rank is None else 1.0 / first_rank,
            }
        )
    count = len(rows)
    if count == 0:
        raise ValueError("evaluation set must not be empty")
    metrics = {
        "questions": count,
        "hitAt1": sum(row["hitAt1"] for row in rows) / count,
        "hitAt3": sum(row["hitAt3"] for row in rows) / count,
        "hitAt5": sum(row["hitAt5"] for row in rows) / count,
        "mrrAt5": sum(row["reciprocalRankAt5"] for row in rows) / count,
    }
    return rows, metrics


def build_rankings(cases: list[dict], corpus: dict[str, dict], model_name: str) -> dict[str, dict[str, list[str]]]:
    embedding = SentenceTransformerEmbedding(model_name, local_files_only=True)
    rankings = {"bm25": {}, "dense": {}, "hybrid": {}}
    cases_by_paper: dict[str, list[dict]] = defaultdict(list)
    for case in cases:
        cases_by_paper[case["paper"]].append(case)

    for paper, paper_cases in cases_by_paper.items():
        row = corpus[paper]
        chunks = row["chunks"]
        evidence_dir = row["evidenceDir"]
        paper_id = row["paperId"]
        dense_index = faiss.read_index(str(evidence_dir / "faiss.index"))
        if dense_index.ntotal != len(chunks):
            raise ValueError(f"FAISS/Chunk count mismatch for {paper}")
        sparse_index = KeywordStore(chunks)
        hybrid = HybridRetriever(embedding).load(evidence_dir, paper_id)
        candidate_count = min(10, len(chunks))

        for case in paper_cases:
            query = case["question"]
            sparse_ids = [chunk.chunk_id for chunk, _ in sparse_index.search(query, candidate_count)]
            vector = np.asarray([embedding.embed_query(query)], dtype=np.float32)
            faiss.normalize_L2(vector)
            _, dense_indices = dense_index.search(vector, candidate_count)
            dense_ids = [chunks[index].chunk_id for index in dense_indices[0] if index >= 0]
            expected_hybrid = [chunk_id for chunk_id, _ in reciprocal_rank_fusion([dense_ids, sparse_ids])][:5]
            product_hybrid = [chunk.chunk_id for chunk, _ in hybrid.search(query, 5)]
            if expected_hybrid != product_hybrid:
                raise ValueError(f"Hybrid parity mismatch for {case['id']}")
            rankings["bm25"][case["id"]] = sparse_ids[:5]
            rankings["dense"][case["id"]] = dense_ids[:5]
            rankings["hybrid"][case["id"]] = product_hybrid
    return rankings


def category_metrics(cases: list[dict], rankings: dict[str, list[str]]) -> dict[str, dict]:
    result = {}
    for category in sorted(CATEGORIES):
        selected = [case for case in cases if case["category"] == category]
        _, result[category] = score_rankings(selected, rankings)
    return result


def percentage(value: float) -> str:
    return f"{value * 100:.1f}%"


def render_summary(payload: dict) -> str:
    metrics = payload["metrics"]
    lines = [
        "# 20条中文单论文RAG检索评测",
        "",
        f"- 冻结测试集SHA256：`{payload['datasetSha256']}`",
        f"- 语料：5篇英文超分辨率论文，共{payload['corpus']['chunkCount']}个Chunk",
        f"- Embedding：`{payload['corpus']['embeddingModel']}`",
        "- 查询：20条中文人工标注问题，每篇4条",
        "- 判定：命中Gold Chunk，不以同页任意Chunk代替",
        "",
        "| 方法 | Hit@1 | Hit@3 | Hit@5 | MRR@5 |",
        "| --- | ---: | ---: | ---: | ---: |",
    ]
    for method in ("bm25", "dense", "hybrid"):
        item = metrics[method]
        lines.append(
            f"| {method} | {percentage(item['hitAt1'])} | {percentage(item['hitAt3'])} | "
            f"{percentage(item['hitAt5'])} | {item['mrrAt5']:.3f} |"
        )
    lines.extend(["", "## Hybrid失败案例", ""])
    misses = [row for row in payload["results"]["hybrid"] if not row["hitAt1"]]
    if misses:
        for row in misses:
            rank = row["firstGoldRank"] if row["firstGoldRank"] is not None else "Top-5未命中"
            lines.append(f"- `{row['id']}`（{row['category']}）：Gold首位排名 {rank}。")
    else:
        lines.append("- 无Top-1失败案例。")
    lines.extend(
        [
            "",
            "## 评测边界",
            "",
            "- 这是20条自建冻结封闭测试集，不代表开放域泛化能力。",
            "- 论文为英文、查询为中文，结果包含跨语言检索影响。",
            "- Hybrid采用产品当前RRF实现，未针对测试问题调参。",
            "",
            "## 简历表述",
            "",
            payload["resumeBulletLatex"],
            "",
        ]
    )
    return "\n".join(lines)


def run(cases_path: Path, corpus_path: Path, output_dir: Path) -> dict:
    corpus = load_corpus(corpus_path)
    cases = load_cases(cases_path, corpus)
    corpus_payload = json.loads(corpus_path.read_text(encoding="utf-8"))
    model_name = corpus_payload["embeddingModel"]
    rankings = build_rankings(cases, corpus, model_name)
    method_results = {}
    metrics = {}
    by_category = {}
    for method, method_rankings in rankings.items():
        method_results[method], metrics[method] = score_rankings(cases, method_rankings)
        by_category[method] = category_metrics(cases, method_rankings)
    hybrid = metrics["hybrid"]
    resume_bullet = (
        r"\textbf{面向代码复现的Hybrid RAG：} "
        r"使用PyMuPDF按页解析PDF，构建Dense+BM25混合索引并绑定"
        r"\texttt{paper\_id/page/chunk\_id}；在20条中文人工标注问题上取得"
        rf"\textbf{{Hit@1 {hybrid['hitAt1'] * 100:.1f}\%、"
        rf"Hit@5 {hybrid['hitAt5'] * 100:.1f}\%、MRR {hybrid['mrrAt5']:.3f}}}。"
    )
    payload = {
        "datasetSha256": hashlib.sha256(cases_path.read_bytes()).hexdigest(),
        "corpus": {
            "papers": [row["paper"] for row in corpus_payload["papers"]],
            "chunkCount": sum(row["chunkCount"] for row in corpus_payload["papers"]),
            "embeddingModel": model_name,
            "denseAvailable": all(row["denseAvailable"] for row in corpus_payload["papers"]),
        },
        "metrics": metrics,
        "categoryMetrics": by_category,
        "results": method_results,
        "resumeBulletLatex": resume_bullet,
    }
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "retrieval-results.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    (output_dir / "summary.md").write_text(render_summary(payload), encoding="utf-8")
    return payload


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate Chinese queries over five English papers.")
    parser.add_argument("--cases", type=Path, required=True)
    parser.add_argument("--corpus", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--validate-only", action="store_true")
    args = parser.parse_args()
    corpus = load_corpus(args.corpus.resolve())
    cases = load_cases(args.cases.resolve(), corpus)
    if args.validate_only:
        counts = Counter(case["category"] for case in cases)
        print(f"20 cases, 5 papers, 4 categories: valid {dict(sorted(counts.items()))}")
        return
    if args.output is None:
        parser.error("--output is required unless --validate-only is used")
    payload = run(args.cases.resolve(), args.corpus.resolve(), args.output.resolve())
    print(json.dumps(payload["metrics"], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
