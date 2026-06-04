# 20条中文单论文RAG检索评测

- 冻结测试集SHA256：`a90c8ec10623b0e7853b58bffd9f9629d093afd96a64acb9eb8a32119ca11660`
- 语料：5篇英文超分辨率论文，共280个Chunk
- Embedding：`intfloat/multilingual-e5-small`
- 查询：20条中文人工标注问题，每篇4条
- 判定：命中Gold Chunk，不以同页任意Chunk代替

| 方法   | Hit@1 | Hit@3 | Hit@5 | MRR@5 |
| ------ | ----: | ----: | ----: | ----: |
| bm25   | 15.0% | 30.0% | 35.0% | 0.227 |
| dense  |  5.0% | 35.0% | 45.0% | 0.206 |
| hybrid | 25.0% | 50.0% | 50.0% | 0.350 |

## Hybrid分类型结果

| 问题类型 | Hit@1 |  Hit@3 |  Hit@5 | MRR@5 |
| -------- | ----: | -----: | -----: | ----: |
| 模型结构 |  0.0% |   0.0% |   0.0% | 0.000 |
| 核心模块 |  0.0% |  40.0% |  40.0% | 0.167 |
| 训练配置 | 20.0% |  60.0% |  60.0% | 0.333 |
| 实验结果 | 80.0% | 100.0% | 100.0% | 0.900 |

## Hybrid失败审计

- 20题中有15题未排在Top-1，其中5题位于第2或第3名，10题在Top-5内未命中。
- Top-5未命中的10题包括5道模型结构题、3道核心模块题和2道训练配置题；逐条检查返回Chunk后，没有发现能够完整回答问题的替代证据，Gold标注无需修改。
- 多数错误结果落在参考文献、数值表格或页面残片；全中文查询缺少英文术语锚点时，当前跨语言向量模型容易发生语义错配，而BM25几乎无法利用中文语义。
- 5道实验结果题全部进入Top-3，其中4道排在Top-1；原因是模型名、数据集名和数值等中英文共享符号提供了稳定的词法锚点。
- Hybrid在Hit@1、Hit@3、Hit@5和MRR@5上均高于两个单路基线，说明RRF融合有效，但25.0%的Hit@1仍不足以作为简历亮点。

### 逐题排名

- `mwat-architecture`（architecture）：Gold首位排名 Top-5未命中。
- `mwat-module`（module）：Gold首位排名 3。
- `mwat-training`（training）：Gold首位排名 Top-5未命中。
- `mwat-results`（results）：Gold首位排名 2。
- `amcanet-architecture`（architecture）：Gold首位排名 Top-5未命中。
- `amcanet-module`（module）：Gold首位排名 2。
- `dmnet-architecture`（architecture）：Gold首位排名 Top-5未命中。
- `dmnet-module`（module）：Gold首位排名 Top-5未命中。
- `dmnet-training`（training）：Gold首位排名 3。
- `focussr-architecture`（architecture）：Gold首位排名 Top-5未命中。
- `focussr-module`（module）：Gold首位排名 Top-5未命中。
- `focussr-training`（training）：Gold首位排名 3。
- `pdah-architecture`（architecture）：Gold首位排名 Top-5未命中。
- `pdah-module`（module）：Gold首位排名 Top-5未命中。
- `pdah-training`（training）：Gold首位排名 Top-5未命中。

## 评测边界

- 这是20条自建冻结封闭测试集，不代表开放域泛化能力。
- 论文为英文、查询为中文，结果包含跨语言检索影响。
- Hybrid采用产品当前RRF实现，未针对测试问题调参。

## 简历表述

\textbf{面向代码复现的Hybrid RAG：} 使用PyMuPDF按页解析PDF，构建Dense+BM25混合索引并绑定\texttt{paper\_id/page/chunk\_id}；在20条中文人工标注问题上取得\textbf{Hit@1 25.0\%、Hit@5 50.0\%、MRR 0.350}。

> 当前分数用于记录真实基线，不建议直接写入简历；应先增加中英查询改写或改用更强的跨语言Embedding，并在同一冻结测试集上重新评测。
