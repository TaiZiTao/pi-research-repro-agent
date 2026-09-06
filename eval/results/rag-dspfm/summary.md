# DSPFM RAG Retrieval Evaluation

- Questions: 36 manually labeled
- Corpus: 37 chunks
- Dense model: `BAAI/bge-small-zh-v1.5`
- Cutoff: 5
- Best method by MRR@5: `bm25`

| Method | Hit@1 | Hit@5 | MRR@5 |
| ------ | ----: | ----: | ----: |
| bm25   | 47.2% | 72.2% | 0.575 |
| dense  | 30.6% | 52.8% | 0.372 |
| hybrid | 33.3% | 72.2% | 0.473 |
