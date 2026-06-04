# 20-Case Chinese RAG Evaluation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and run a frozen 20-question Chinese benchmark over five English super-resolution papers, comparing BM25, Dense, and the product's Hybrid retriever with Chunk-level Gold evidence.

**Architecture:** Reuse the production PyMuPDF ingestion and `python.paper_worker.rag` retrieval code. A preparation script imports five fixed PDFs and verifies that every index has a real Dense FAISS index; a frozen JSONL dataset maps each natural Chinese question to exact evidence Chunks; an evaluator runs three retrieval modes against the same indexes and writes auditable per-case and aggregate results.

**Tech Stack:** Python 3.13 from `D:\anaconda3`, PyMuPDF, SentenceTransformers, `intfloat/multilingual-e5-small`, FAISS, rank-bm25, Node.js research CLI, unittest.

---

## File structure

- Create `eval/rag2026/prepare_corpus.py`: import the fixed five PDFs through the product ingestion path and emit a local paper-to-index manifest.
- Create `eval/rag2026/chinese_cases.jsonl`: the frozen 20-case manual annotation set.
- Create `eval/rag2026/run_chinese_eval.py`: validate annotations, build BM25/Dense/Hybrid rankings, score them, and render reports.
- Create `eval/rag2026/test_chinese_eval.py`: focused tests for the schema and retrieval metrics.
- Create `eval/results/rag-zh20/retrieval-results.json`: per-case rankings and aggregate metrics.
- Create `eval/results/rag-zh20/summary.md`: benchmark method, limits, scores, and failure analysis.
- Modify `.gitignore`: ignore the local corpus manifest and imported evaluation workspaces while retaining the frozen cases and reports.

### Task 1: Prepare five production-equivalent indexes

**Files:**

- Create: `eval/rag2026/prepare_corpus.py`
- Modify: `.gitignore`

- [ ] **Step 1: Fix the paper set and embedding configuration**

Use these five PDFs from `E:\paper\2026`:

```python
PAPERS = [
    "A lightweight multi-window attention transformer for image super-resolution.pdf",
    "Chen_AMCANet_A_Lightweight_Architecture-guided_Multi-head_Convolution_Attention_Network_for_Efficient_CVPRW_2026_paper.pdf",
    "Dual-domainModulationNetworkforLightweight.pdf",
    "Focus-guided feature fusion network for lightweight image super-resolution.pdf",
    "PDAH-SR：Prior-driven direction-aware hierarchical shunting for lightweight super-resolution.pdf",
]
MODEL = "intfloat/multilingual-e5-small"
```

- [ ] **Step 2: Implement corpus preparation through the real import CLI**

For every paper, call `scripts/research-paper.mjs import` with:

```python
env["RESEARCH_PYTHON"] = r"D:\anaconda3\python.exe"
env["RESEARCH_EMBEDDING_MODEL"] = MODEL
env["RESEARCH_EMBEDDING_LOCAL_ONLY"] = "1"
```

Write `eval/rag2026/corpus-manifest.local.json` containing the source filename, project ID, SHA256, evidence directory, Chunk count, embedding model, and `denseAvailable` value.

- [ ] **Step 3: Make Dense availability a hard gate**

After each import, load `evidence/manifest.json` and stop with a non-zero exit when any of these conditions fails:

```python
assert manifest["denseAvailable"] is True
assert manifest["model"] == MODEL
assert Path(evidence_dir, "faiss.index").is_file()
assert manifest["chunkCount"] > 0
```

- [ ] **Step 4: Run corpus preparation**

Run:

```powershell
D:\anaconda3\python.exe eval\rag2026\prepare_corpus.py
```

Expected: five rows report `denseAvailable=true`; otherwise install/cache the declared model and rerun from a clean evaluation workspace.

- [ ] **Step 5: Commit preparation code**

```powershell
git add .gitignore eval/rag2026/prepare_corpus.py
git commit -m "eval(rag): prepare five-paper Chinese benchmark corpus"
```

### Task 2: Add metric and annotation validation

**Files:**

- Create: `eval/rag2026/run_chinese_eval.py`
- Create: `eval/rag2026/test_chinese_eval.py`

- [ ] **Step 1: Write focused failing tests**

Cover these behaviors in `test_chinese_eval.py` with concrete fixtures:

```python
class ChineseEvalTest(unittest.TestCase):
    def test_metrics_include_hit_at_1_3_5_and_mrr_at_5(self):
        metrics = score_rankings(
            [
                {"id": "q1", "goldChunkIds": ["g1"]},
                {"id": "q2", "goldChunkIds": ["g2"]},
                {"id": "q3", "goldChunkIds": ["g3"]},
            ],
            {"q1": ["g1"], "q2": ["x", "y", "g2"], "q3": ["x", "y", "z"]},
        )[1]
        self.assertAlmostEqual(metrics["hitAt1"], 1 / 3)
        self.assertAlmostEqual(metrics["hitAt3"], 2 / 3)
        self.assertAlmostEqual(metrics["hitAt5"], 2 / 3)
        self.assertAlmostEqual(metrics["mrrAt5"], (1 + 1 / 3) / 3)

    def test_dataset_requires_exactly_twenty_cases(self):
        with self.assertRaisesRegex(ValueError, "20 cases"):
            validate_dataset_shape([])

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
```

The metric fixture must verify that Gold ranks `1`, `3`, and missing produce Hit@1 `1/3`, Hit@3 `2/3`, Hit@5 `2/3`, and MRR@5 `(1 + 1/3) / 3`.

- [ ] **Step 2: Run tests and confirm the module is absent**

Run:

```powershell
D:\anaconda3\python.exe -m unittest eval.rag2026.test_chinese_eval -v
```

Expected: FAIL because `run_chinese_eval` is not implemented.

- [ ] **Step 3: Implement the validator and metrics**

Each JSONL record must contain:

```json
{
  "id": "mwat-architecture",
  "paper": "paper.pdf",
  "category": "architecture",
  "question": "模型如何逐步扩大注意力的感受范围？",
  "goldChunkIds": ["p2-c1"],
  "goldPages": [2],
  "evidenceText": "short verbatim evidence excerpt",
  "annotationNote": "why this evidence answers the question"
}
```

Validation must require 20 unique IDs and questions, five papers with four cases each, the four categories `architecture`, `module`, `training`, and `results` once per paper, at least one CJK character in every question, valid Gold Chunk IDs, matching pages, and normalized `evidenceText` contained in a Gold Chunk.

- [ ] **Step 4: Implement unified ranking and scoring**

For each paper, load the production `chunks.json`, `faiss.index`, and model manifest. Generate Top-5 rankings from:

```python
methods = ("bm25", "dense", "hybrid")
```

Use `KeywordStore` for BM25, the declared SentenceTransformer plus FAISS for Dense, and `HybridRetriever.search()` for Hybrid. Assert the Hybrid output matches the production RRF code path. Save returned Chunk IDs, pages, and first Gold rank; do not present BM25, cosine, and RRF scores as directly comparable values.

- [ ] **Step 5: Run tests until they pass**

Run:

```powershell
D:\anaconda3\python.exe -m unittest eval.rag2026.test_chinese_eval -v
```

Expected: all focused evaluator tests PASS.

- [ ] **Step 6: Commit evaluator code**

```powershell
git add eval/rag2026/run_chinese_eval.py eval/rag2026/test_chinese_eval.py
git commit -m "eval(rag): add multi-paper Chunk-level evaluator"
```

### Task 3: Create and freeze the 20 Chinese annotations

**Files:**

- Create: `eval/rag2026/chinese_cases.jsonl`

- [ ] **Step 1: Inspect all Chunks before writing questions**

For each of the five paper indexes, review the full Chunk text and record candidate evidence for exactly four categories: architecture, module, training, and results.

- [ ] **Step 2: Write four natural Chinese questions per paper**

Questions must describe the information need without copying an English sentence, stacking exact numeric values, or using a unique module abbreviation as the only clue. Preserve model abbreviations only when a normal user would need them to identify the subject.

- [ ] **Step 3: Attach exact Gold evidence**

For every question, select the smallest sufficient Gold Chunk set, copy a short evidence excerpt, record its page, and explain the label in `annotationNote`. Multiple Gold Chunks are allowed only for a split table or an answer that crosses an adjacent Chunk boundary.

- [ ] **Step 4: Freeze and validate the dataset before retrieval**

Run:

```powershell
D:\anaconda3\python.exe eval\rag2026\run_chinese_eval.py --validate-only --cases eval\rag2026\chinese_cases.jsonl --corpus eval\rag2026\corpus-manifest.local.json
```

Expected: `20 cases, 5 papers, 4 categories: valid`. Record the annotation file's SHA256 in the later report; do not edit the file after this point.

- [ ] **Step 5: Commit the frozen dataset**

```powershell
git add eval/rag2026/chinese_cases.jsonl
git commit -m "eval(rag): freeze 20 Chinese evidence questions"
```

### Task 4: Run and audit the benchmark

**Files:**

- Create: `eval/results/rag-zh20/retrieval-results.json`
- Create: `eval/results/rag-zh20/summary.md`

- [ ] **Step 1: Run all three retrieval methods**

Run:

```powershell
D:\anaconda3\python.exe eval\rag2026\run_chinese_eval.py --cases eval\rag2026\chinese_cases.jsonl --corpus eval\rag2026\corpus-manifest.local.json --output eval\results\rag-zh20
```

Expected: 60 evaluated method-case pairs and metrics for BM25, Dense, and Hybrid.

- [ ] **Step 2: Audit every miss**

For every case whose Gold first appears below rank 1 or is absent from Top-5, compare the returned Chunk text with the Gold evidence. Classify the cause as query translation, Chunk boundary, lexical mismatch, semantic mismatch, or annotation ambiguity. If the annotation is genuinely ambiguous, report it as an annotation issue and rerun only after documenting the correction and creating a new dataset hash; never silently rewrite difficult questions.

- [ ] **Step 3: Write an honest summary**

The report must include the dataset SHA256, five paper names, embedding model, Chunk counts, exact metric table, per-category breakdown, failed-case list, and these limitations: 20-case self-built closed set, English papers queried in Chinese, and no claim of open-domain generalization.

- [ ] **Step 4: Re-run focused tests and benchmark reproducibility check**

Run the unit tests once, then rerun the benchmark and compare the new result JSON hash with the first run. Expected: tests PASS and both result files are byte-identical.

- [ ] **Step 5: Commit results**

```powershell
git add eval/results/rag-zh20/retrieval-results.json eval/results/rag-zh20/summary.md
git commit -m "eval(rag): report frozen 20-case Chinese benchmark"
```

### Task 5: Produce the resume line

**Files:**

- Modify: `eval/results/rag-zh20/summary.md`

- [ ] **Step 1: Select the reported method without cherry-picking**

Report Hybrid as the product path. Include BM25 and Dense in the technical report even if either baseline scores higher. Do not claim that Hybrid improves retrieval unless its measured result exceeds both baselines under the frozen dataset.

- [ ] **Step 2: Add a two-line LaTeX-ready bullet**

Generate the bullet directly from the final Hybrid metrics so the displayed values cannot drift from the report:

```python
hybrid = payload["metrics"]["hybrid"]
resume_line = (
    r"\textbf{面向代码复现的Hybrid RAG：} "
    r"使用PyMuPDF按页解析PDF，构建Dense+BM25混合索引并绑定"
    r"\texttt{paper\_id/page/chunk\_id}；在20条中文人工标注问题上取得"
    rf"\textbf{{Hit@1 {hybrid['hitAt1'] * 100:.1f}\%、"
    rf"Hit@5 {hybrid['hitAt5'] * 100:.1f}\%、MRR {hybrid['mrrAt5']:.3f}}}。"
)
```

- [ ] **Step 3: Final truthfulness check**

Confirm that every number in the resume bullet exactly matches `retrieval-results.json`, that the report explicitly says this is a frozen self-built set, and that the former page-level `90%/100%` result is not reused.

- [ ] **Step 4: Commit the resume-ready summary**

```powershell
git add eval/results/rag-zh20/summary.md
git commit -m "docs(eval): add verified RAG resume metrics"
```
