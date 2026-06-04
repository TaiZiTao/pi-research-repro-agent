# RAG Retrieval Evaluation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and run a frozen 36-question single-paper retrieval benchmark comparing BM25, Dense, and the project's current Hybrid retriever.

**Architecture:** Store manually authored questions and Gold Chunk IDs in JSONL. A standalone Python evaluator loads the existing chunks and FAISS index, obtains rankings from each retrieval path, validates every case before scoring, and writes immutable per-query results plus aggregate metrics.

**Tech Stack:** Python 3.12, sentence-transformers, FAISS, rank-bm25, existing `python.paper_worker.rag` modules, JSON/JSONL, unittest.

---

### Task 1: Freeze the DSPFM evaluation set

**Files:**

- Create: `eval/rag/dspfm_cases.jsonl`

- [ ] **Step 1: Author 36 evidence questions**

Use records with this exact schema:

```json
{
  "id": "dspfm-001",
  "question": "DSPFM由哪三个主要阶段组成？",
  "goldChunkIds": ["p3-c2"],
  "goldPages": [3],
  "category": "architecture",
  "rationale": "总体架构定义位于方法章节。"
}
```

Cover architecture, DirRPB/DirMSA, SFCA/SMM, training configuration, ablations, and benchmark results. Include Chinese and English paraphrases, and allow multiple Gold Chunks only when a table or paragraph boundary genuinely splits the answer.

- [ ] **Step 2: Validate labels against the frozen chunks**

Check that there are exactly 36 unique IDs, every question is non-empty, every Gold Chunk exists in the current 37-Chunk corpus, and every Gold page equals the referenced Chunk page.

- [ ] **Step 3: Commit the frozen cases**

```text
git add eval/rag/dspfm_cases.jsonl
git commit -m "eval: freeze dspfm retrieval cases"
```

### Task 2: Implement deterministic three-way scoring

**Files:**

- Create: `eval/rag/run_retrieval_eval.py`
- Create: `eval/rag/test_retrieval_eval.py`

- [ ] **Step 1: Write metric unit tests**

Test `reciprocal_rank`, `score_rankings`, case validation, and the rule that a missing Gold Chunk within Top-5 contributes zero to MRR.

```python
def test_reciprocal_rank_uses_first_gold_hit():
    assert reciprocal_rank(["x", "gold", "y"], {"gold"}, cutoff=5) == 0.5
```

- [ ] **Step 2: Run the unit tests and observe failure**

```text
D:\anaconda3\python.exe -m unittest eval.rag.test_retrieval_eval -v
```

Expected: import failure because `run_retrieval_eval.py` does not exist.

- [ ] **Step 3: Implement evaluator**

Load `chunks.json`, `manifest.json`, and `faiss.index`; build BM25 rankings with `KeywordStore`, Dense rankings with normalized BGE query vectors and FAISS, and Hybrid rankings with the existing `HybridRetriever.search`. Score Hit@1, Hit@5, and MRR@5 without changing queries, labels, fusion logic, or index weights.

- [ ] **Step 4: Run unit tests**

```text
D:\anaconda3\python.exe -m unittest eval.rag.test_retrieval_eval -v
```

Expected: all tests pass.

- [ ] **Step 5: Commit evaluator**

```text
git add eval/rag/run_retrieval_eval.py eval/rag/test_retrieval_eval.py
git commit -m "eval: add rag retrieval benchmark"
```

### Task 3: Run and report the benchmark

**Files:**

- Create: `eval/results/rag-dspfm/retrieval-results.json`
- Create: `eval/results/rag-dspfm/summary.md`

- [ ] **Step 1: Execute the frozen benchmark**

```text
D:\anaconda3\python.exe eval/rag/run_retrieval_eval.py --cases eval/rag/dspfm_cases.jsonl --index "C:\Users\17093\AppData\Roaming\Pi Agent Desktop\research\projects\ef5f741f-7b77-4f68-a75f-e2a4a7eb7e30\evidence" --output eval/results/rag-dspfm
```

Expected: 36 valid cases and metrics for `bm25`, `dense`, and `hybrid`.

- [ ] **Step 2: Verify output integrity**

Confirm the results contain 36 rows per method, metrics recompute from those rows, no Gold label changed, and the manifest still reports 37 Chunks with `denseAvailable: true`.

- [ ] **Step 3: Write the resume line from measured output**

The summary must name the winning method and include its exact Hit@1, Hit@5, and MRR@5 values, explicitly qualified as results on 36 manually labeled questions.

- [ ] **Step 4: Commit results**

```text
git add eval/results/rag-dspfm
git commit -m "eval: record dspfm rag retrieval results"
```
