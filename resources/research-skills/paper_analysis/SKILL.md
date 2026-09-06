---
name: paper_analysis
description: Analyze the current single paper for summary, requested translation, grounded question answering, or structured review. Use only when a research-project.json marker and parsed evidence exist.
---

# Paper Analysis

Work only on the paper bound to the current project.

1. Identify whether the user requests summary, translation, question answering, or review.
2. Call `research_search_evidence` before making factual claims.
3. Draft a structured answer with `status`, `answer`, and `citations`; every citation includes the returned `paperId`, `page`, `chunkId`, and a short exact quote.
4. Call `research_finalize_answer` before presenting the answer. If verification fails, revise the retrieval once; after a second failure, return insufficient evidence.
5. Render accepted citations as `[p.<page> · <chunkId>]` and distinguish paper facts from your own evaluation.
6. If evidence is missing, use `status=insufficient_evidence` and say that the current paper does not provide enough evidence.
7. Never invent a page, chunk, equation, experiment, repository, or reported metric.

Translation is opt-in and limited to the requested passage. Review output covers contribution, soundness, experiment quality, limitations, and questions for the authors.
