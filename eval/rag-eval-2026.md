# RAG 证据检索评测(2026-09-04)

## 方法

- 语料:`E:\paper\2026` 中 4 篇 lightweight image super-resolution 论文(PyMuPDF 分页 → Dense+BM25 混合索引,与桌面 research 运行时同一管线)。
- 标注:`eval/rag-annotations-2026.json`,20 条事实型英文问题(4 篇 × 5),gold 页由论文全文关键词锚点 + 人工核定,每问 1 个主答案页。
- 检索:每问 `research_search_evidence(query, limit=5)`(温度无关,BM25+向量混合,同 app)。
- 判定:gold 页出现在返回页码序列第 k 位算 hit@k;MRR 取首个命中页倒数。

## 结果

| 指标  | 值           |
| ----- | ------------ |
| Hit@1 | 90.0%(18/20) |
| Hit@3 | 100%(20/20)  |
| Hit@5 | 100%(20/20)  |
| MRR   | 0.9417       |

未 top1 命中的 2 例均在 dual-domain 论文的方法/损失细节问(rank2/3 命中)。明细见 `eval/rag-eval-2026.json`。

## 诚实边界

- 封闭集:标注与索引同源 4 篇论文,衡量的是检索管线在本语料上的命中能力,不代表跨域/开放语料泛化。
- gold 页为单页主答案页;若正文多处同义表述,判定偏严(仍有 90% hit@1)。
- 问题为英文关键词风格;中文 query 对英文论文的词匹配弱(已知限制,未纳入本评测)。
