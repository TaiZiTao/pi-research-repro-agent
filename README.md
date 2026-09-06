# Pi Research Reproduction Agent(科研论文复现 Coding Agent)

基于 **Pi Agent Desktop** 二次开发的"单论文科研复现 Agent":输入一篇论文(PDF),完成
**论文检索 → 证据问答 → 受控代码复现** 的闭环。以 DeepSeek 负责理解/规划/代码生成,
本地 **Qwen3-0.6B LoRA 工具路由**在后台参与工具决策。

> 数据与结果全部真实可复核;训练数据为确定性生成+少量真实,已显式标注 synthetic。

## 架构分层

- **知识侧(论文)**:PyMuPDF 分页切块 → Dense(多语言 e5 + faiss 余弦)+ BM25 双路召回、RRF 融合;
  Chunk 绑定 paper_id/page/chunk_id,命中证据逐条溯源;Citation Verify 校验引用真实。
- **决策侧**:DeepSeek 为主会话模型;Qwen3-0.6B LoRA(FP16,257 轨迹/511 决策样本)作本地
  工具路由器(off / 单次建议 / 多轮只读工具链),决策只对会话真实活动工具生效、≤4 步,
  状态变更类工具仍由 DeepSeek 经宿主门禁执行。
- **执行侧**:8 阶段 Workflow(获取/解析/证据检索/仓库检验/规划/配置/受控执行/验收);
  官方仓库复现或无仓库 Agent 重建双路径,失败自动修复 ≤3 轮,产物 SHA256 确定性验收。

## 目录

- src/ — Electron 桌面(renderer)+ agent-host 科研运行时与 RPC 契约
- python/paper_worker/ — PDF 解析、Hybrid RAG(embedding/retriever/fusion)
- training/ — 轨迹生成、Schema 校验、LoRA 训练/评测管线
- eval/ — 111 条工具决策评测、36 条证据检索标注与结果
- python/agent_rebuilds/ — 无官方仓库时的 Agent 重建代码示例(DSPFM)
- docs/ — 结果归档 results.md、使用演示 research-agent-usage.md

## 快速开始与复现

```
npm run build      # 构建桌面端(main + renderer)
npm run test       # 科研/评测相关单元测试
python -m training.validate_dataset training/data/raw/golden.jsonl   # 数据集校验
python eval/run_eval.py --model <qwen> --adapter <lora>/adapter --output-dir eval/results/x
```

## 说明与边界

- 桌面 research 运行时与模型推理需本地 Python(pymupdf/faiss/sentence-transformers)与 CUDA;
- 评测为封闭同源语料,详见 eval/ 下口径说明;中文 query 对英文论文的弱匹配为已知限制;
- 本项目基于上游 Pi Agent Desktop 二次开发,上游代码与其许可归原项目所有。
