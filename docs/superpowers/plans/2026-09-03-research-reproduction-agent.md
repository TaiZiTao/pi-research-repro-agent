# Research Reproduction Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 14 天完成一个可写进简历、可现场演示的单论文科研复现 Coding Agent。

**Architecture:** 复用现有 Pi Agent、PDF 项目与 Skill 底座；新增混合 RAG、CitationVerify、科研资源 MCP 和复现任务状态机。QLoRA 只强化多轮工具调用与报错纠正，并通过固定测试集与基础模型对比。

**Tech Stack:** TypeScript、Pi Agent、Python、PyMuPDF、SQLite、MCP、BM25、多语言 Embedding、PyTorch/Transformers/PEFT/QLoRA。

> **进度（2026-09-03 回填）**：✅ 底座 + 第 1～3 天 + 第 4～5 天（MCP 获取）+ 第 6～8 天（复现 Workflow）已完成；⬜ 第 9～10 天（QLoRA 数据集）起未开始。**约定：每完成一步立即勾选，并在提交时同步本文件。**

---

## 已完成底座（直接复用）

- [x] PDF 校验、复制、解析和页码切块。
- [x] SQLite 项目持久化与隔离工作区。
- [x] 科研项目状态机（`created → acquiring → ingesting → ready | failed | cancelled`）与事件记录。
- [x] 3 个 Skill 骨架。
- [x] Pi `research_search_evidence` 工具。
- [x] PDF 导入、列表和检索 CLI。

相关目录：

- `src/agent-host/research/`
- `python/paper_worker/`
- `resources/research-skills/`

## 第 1～2 天：混合 RAG

**修改：**

- `python/paper_worker/parse_pdf.py`
- `src/agent-host/research/evidence-search.ts`
- `src/agent-host/research/project-service.ts`
- `src/shared/research/types.ts`

**新增：**

- `python/paper_worker/embed_text.py` ⚠️ 实现差异：实际落地为 `python/paper_worker/rag/` 包（`embedding.py` / `keyword_store.py` / `fusion.py` / `retriever.py` / `models.py`）与 `python/paper_worker/hybrid_search.py`
- `src/agent-host/research/hybrid-index.ts` ⚠️ 实现差异：实际落地为 `src/agent-host/research/hybrid-worker.ts`
- 对应测试文件（TS `hybrid-worker.test.mjs`；Python `test_rag.py`）

**步骤：**

- [x] 先写失败测试：章节、页码、块 ID 和空文本处理。
- [x] 将当前关键词检索升级为 BM25，并保留纯关键词匹配作为最终回退。
- [x] 接入轻量级多语言 Embedding，持久化论文向量。
- [x] 使用 RRF 融合稀疏与向量结果，返回 Top-K 证据。
- [x] 用中文问题检索英文超分论文，确认命中正确页码。
- [x] 运行科研模块测试、Python 测试和类型检查后提交。

**降级：** Embedding 模型不可用时自动使用 BM25，不能阻塞论文问答。

> 注记：中文检索验证见 `python/paper_worker/test_rag.py`（`"证据"` 命中含页码的 `p2-c1` 块）；TS 侧 `evidence-search.test.mjs` 覆盖汉字匹配。提交：`009a652`（migrate hybrid paper retrieval）。⚠️ 仍缺：尚未用真实英文超分论文做端到端中文问答核对页码（计划第 14 天补）。

## 第 3 天：CitationVerify 与约束

**新增：**

- `src/agent-host/research/citation-verifier.ts`
- `src/agent-host/research/citation-verifier.test.mjs`
- `src/agent-host/research/answer-schema.ts`

**修改：**

- `src/agent-host/research/tools.ts`
- `resources/research-skills/paper_analysis/SKILL.md`

**步骤：**

- [x] 写失败测试：伪造页码、错误块 ID、跨项目引用和无证据结论。
- [x] 定义 `answer + citations` 结构化输出。
- [x] 新增回答校验工具，验证引用与真实证据块一致。
- [x] 校验失败时允许重检索一次，仍失败则返回证据不足。
- [x] 限制查询长度、Top-K、工具次数和输出大小。
- [x] 通过测试后提交。

> 注记：查询 ≤1000 字符、Top-K 1..8、answer ≤6000、citations ≤8、quote 8..500 已由 Schema + 校验器限制；⚠️「每轮工具调用次数」硬上限尚未实现（留待复现切片补）。重检索一次的策略写入 `paper_analysis` Skill。提交：`77fe8be`（verify grounded paper answers）。

## 第 4～5 天：论文搜索与下载 MCP

**新增：**

- `mcp/research-acquisition/server.ts`
- `mcp/research-acquisition/paper-sources.ts`
- `mcp/research-acquisition/download.ts`
- `src/agent-host/research/mcp-client.ts`
- 对应测试文件

**修改：**

- `package.json`
- `src/agent-host/research/tools.ts`

**步骤：**

- [x] 安装并锁定官方 MCP SDK。
- [x] 实现 `search_papers`，聚合 arXiv 与 OpenAlex 并去重。
- [x] 返回候选列表，必须由用户选择论文。
- [x] 实现 `download_paper`，只接受开放 PDF，并校验类型、大小和哈希。
- [x] 实现 `search_repositories`，保存 URL、commit、许可证和匹配依据。
- [x] 将 MCP 工具代理到 Pi，增加超时、错误回退和脱敏测试。
- [x] 用真实关键词完成一次搜索、选择和下载后提交。

> 注记（2026-09-03 完成）：实现分两层 —— MCP server 在 `mcp/research-acquisition/`（`server.ts` / `paper-sources.ts` / `download.ts`），客户端门面与 Pi 工具定义在 `src/agent-host/research/`（`mcp-client.ts` + `tools.ts` 的 `research_search_papers` / `research_download_paper` / `research_search_repositories`；`download` 固定写入托管 downloadsRoot，模型不能指定任意写路径）。
>
> - ⚠️ 差异：rpc-manager 会话接线未做 —— stdio transport 子进程生命周期与打包版 serverPath 解析需在桌面会话集成时统一处理（建议：research 运行时单例持有共享 client，会话销毁时关闭）。代理工具定义、超时（20s 默认 + SDK 按请求超时）、错误回退、脱敏（token/本地路径 [redacted]）均有测试覆盖。
> - ✅ 真实端到端：搜索 “single image super-resolution” → 选中 arXiv 2607.09351（Simon-SR，813KB）→ 下载（%PDF- 魔数 + sha256）→ CLI 导入 `ready`（5 页）→ 英文证据检索命中页码。GitHub 仓库搜索对 Simon-SR 无结果（新论文），机制已用 Real-ESRGAN 单独验证。
> - ⚠️ 环境限制（本机）：e5 embedding 未缓存且 HuggingFace 不可达 → 索引降级 BM25（设计内），中文 query 检索英文论文需 dense（第 14 天演示前补）；arXiv 大文件下载需 IPv4 优先 + 长超时（SDK 默认 60s 不够）；OpenAlex 指向出版商托管的 PDF（如 MDPI）会 418。
> - 🔧 顺带修复：`parse_pdf.py` 按码点切块导致含增补平面字符（数学符号）的论文块 JS 长度超 1200 → 改按 UTF-16 单元切块并加测试（`bd38aa5`）。

## 第 6～8 天：代码复现 Workflow

**新增：**

- `src/agent-host/research/reproduction/types.ts`
- `src/agent-host/research/reproduction/store.ts`
- `src/agent-host/research/reproduction/planner.ts`
- `src/agent-host/research/reproduction/executor.ts`
- `src/agent-host/research/reproduction/report.ts`
- 对应测试文件

**修改：**

- `resources/research-skills/reproduction_planning/SKILL.md`
- `resources/research-skills/reproduction_execution/SKILL.md`
- `src/agent-host/research/tools.ts`

**步骤：**

- [x] 定义 `planned → preparing → running → verifying → completed/blocked` 状态机。
- [x] 从论文证据提取模型、数据、损失、训练配置和指标。
- [x] 核验官方仓库；没有仓库时生成“Agent 最小复现”计划。
- [x] 将命令限制在本次复现工作区，并记录命令、退出码和产物。
- [x] 实现超时、危险命令拦截和最多 3 轮报错纠正。
- [x] 保存断点状态，避免恢复后重复执行成功步骤。
- [x] 生成带来源、环境、指标和失败说明的复现报告。
- [x] 用一个小型超分模块跑通真实错误修复后提交。

> 注记（2026-09-03 完成）：实现落在 `src/agent-host/research/reproduction/` —— 领域层 `types/state-machine/store/paths/planner/report`（`88466f9`）、执行器 `executor.ts`（隔离 workspace、危险命令拒绝表、每命令超时、产物写 `artifacts/logs/<step>.log`、断点跳过成功步、`resetFailedSteps` + 最多 3 轮修复，`2ce79ef`）、Pi 工具 `reproduction-tools.ts`（`research_plan_reproduction` / `research_reproduction_execute` / `research_reproduction_verify` / `research_reproduction_report`,tools.ts re-export,`74a1ecd`）与两个 reproduction SKILL.md 由“禁用”占位改为可用说明。
>
> - ✅ 真实错误修复演示：小型超分模块（numpy 合成图 + 2x 最近邻 + PSNR）首跑 `NameError: compute_psnr`（exit 1，真实 stderr 入日志）→ `verify(accepted=false, reason)` 进入修复轮 1 → 补上 PSNR 实现后重跑成功 → 校验步通过 → `completed`（repairRoundsUsed=1），报告标注 “(Agent 最小复现)” 并含来源/步骤表/产物。
> - ⚠️ 差异/待办：执行器的真实命令 Runner 由上层注入（demo 用 `child_process.exec` 包装）；`rpc-manager` 会话接线（复现工具 + 复现 store 的运行时单例与生命周期）与 acquisition 一样留待桌面会话集成；仓库核验目前依赖 acquisition `search_repositories` 的候选（day 4-5），planner 按 https+matchBasis 采用，否则自动标注 Agent 最小复现。
> - ✅ 测试：科研+mcp+reproduction Node 测试 124/124；Python test_rag/test_parse_pdf OK；typecheck 与全量 lint 0 错。

## 第 9～10 天：QLoRA 数据集

**新增：**

- `training/schema.py`
- `training/build_dataset.py`
- `training/validate_dataset.py`
- `training/scenarios/`
- `training/tests/`

**步骤：**

- [ ] 固定 Pi 工具调用消息格式和数据 Schema。
- [ ] 从真实运行日志提取并脱敏成功与失败轨迹。
- [ ] 补充论文获取、证据问答、仓库判断、代码执行和纠错场景。
- [ ] 先生成并人工抽查 100 条轨迹。
- [ ] 按论文及错误类型划分训练、验证和测试集，防止泄漏。
- [ ] 扩展到约 800～1200 条；只记录真实数量。
- [ ] 运行格式、重复、泄漏和参数合法性检查后提交。

## 第 11～12 天：QLoRA 训练与接入

**新增：**

- `training/train_qlora.py`
- `training/infer.py`
- `training/configs/qwen2.5-coder-1.5b.yaml`
- `training/README.md`

**步骤：**

- [ ] 安装固定版本的 Transformers、PEFT、TRL 和量化依赖。
- [ ] 用 100 条数据运行一次显存与保存/加载冒烟测试。
- [ ] 使用 Qwen2.5-Coder-1.5B-Instruct、4-bit NF4、rank 16 训练。
- [ ] 记录显存、耗时、Loss、随机种子和最终 Adapter。
- [ ] 通过本地 OpenAI 兼容接口让 Pi 可切换 Base/QLoRA。
- [ ] 验证两种模型使用相同提示词和工具定义后提交。

**降级：** 8GB 显存不足时缩短序列或减少批次，不改用无法真实训练的大模型。

## 第 13 天：Base/QLoRA 对照评测

**新增：**

- `eval/run_eval.py`
- `eval/metrics.py`
- `eval/cases/`
- `eval/results/`

**步骤：**

- [ ] 固定测试集、温度、最大轮数和工具定义。
- [ ] 分别运行 Base 与 QLoRA。
- [ ] 计算工具选择、参数合法、报错恢复、拒答、引用和任务完成指标。
- [ ] 同时记录约束前模型指标与约束后系统指标。
- [ ] 保存原始结果与汇总表，禁止人工挑选成功样例。
- [ ] 对失败案例分类并提交评测结果。

## 第 14 天：真实演示与简历材料

**修改/新增：**

- `README.md`
- `docs/workflow.md`
- `docs/demo-script.md`
- `docs/results.md`

**步骤：**

- [ ] 用一篇真实超分论文跑完整流程。
- [ ] 展示证据问答、仓库判断、复现计划、真实报错修复和报告。
- [ ] 整理 Base/QLoRA 对照表与失败案例。
- [ ] 运行科研模块测试、类型检查、Pi 兼容检查和可完成的整库回归。
- [ ] 录制 3～5 分钟演示，补齐架构图和复现命令。
- [ ] 根据真实结果撰写 3～4 条简历描述，不写未完成能力。

## 最终验收

- [ ] 本地 PDF 和 MCP 论文获取至少各跑通一次。
- [ ] 中文问题能够检索英文论文并返回真实页码。
- [ ] 伪造引用、越界路径和危险命令能够被拦截。
- [ ] 无官方仓库时能完成一个明确标注的最小复现。
- [ ] 至少一类真实执行错误能够自动修复。
- [ ] Base/QLoRA 使用相同测试集并产生可复核指标。
- [ ] 不依赖桌面 UI 也能复现演示流程。
