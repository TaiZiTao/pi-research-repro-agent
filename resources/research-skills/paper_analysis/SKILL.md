---
name: paper_analysis
description: Analyze the current single paper for summary, requested translation, grounded question answering, or structured review. Use only when a research-project.json marker and parsed evidence exist.
---

# Paper Analysis

Work only on the paper bound to the current project.

1. Identify whether the user requests summary, translation, question answering, or review.
2. Call `research_search_evidence` before making factual claims.
3. Cite evidence as `[p.<page> · <chunkId>]` using identifiers returned by the tool.
4. Distinguish paper facts from your own evaluation.
5. If evidence is missing, say that the current paper does not provide enough evidence.
6. Never invent a page, chunk, equation, experiment, repository, or reported metric.

Translation is opt-in and limited to the requested passage. Review output covers contribution, soundness, experiment quality, limitations, and questions for the authors.
