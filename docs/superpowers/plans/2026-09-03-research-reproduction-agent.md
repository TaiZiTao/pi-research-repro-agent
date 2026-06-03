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
> - ✅ 会话接线：research runtime 持有 MCP client 与复现 store，`rpc-manager` 为所有会话注册 acquisition 工具，并只为 ready 论文工作区注册证据与复现工具。当前使用 MCP SDK 的进程内 transport，避免额外子进程和打包路径差异。
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

> 注记（2026-09-04 加固）：实现落在 `src/agent-host/research/reproduction/`。五个 Pi 工具覆盖计划、步骤配置、执行、确定性校验与报告；执行采用工作目录、可执行程序白名单、Shell 控制符/路径穿越拦截和超时组成的受控执行，不宣称容器级沙箱。
>
> - ✅ 真实错误修复演示：执行 `node definitely-missing-file.js` 产生真实 exit 1 与 stderr 日志 → repair round 1 → 将当前步骤更新为 `node --version` 并重跑 → 六个步骤全部成功 → 校验器逐一核对日志大小与 SHA256 后才进入 `completed`，报告包含全部日志产物。
> - ✅ 假完成已封堵：模型不再提交 `accepted=true`；pending/failed 步骤以及缺失、越界或被篡改的产物都会拒绝完成。仓库候选强绑定与用户选论文门禁作为非阻塞增强项延后，不影响下一阶段 LoRA 轨迹构建。
> - ✅ 测试：科研+mcp+reproduction Node 测试 124/124；Python test_rag/test_parse_pdf OK；typecheck 与全量 lint 0 错。

## 第 9～10 天：QLoRA 数据集

**新增：**

- `training/schema.py`
- `training/build_dataset.py`
- `training/validate_dataset.py`
- `training/scenarios/`
- `training/tests/`

**步骤：**

- [x] 固定 Pi 工具调用消息格式和数据 Schema。
- [x] 从真实运行日志提取并脱敏首条成功与失败轨迹。
- [x] 补充论文问答、引用纠错、证据不足、代码执行、危险命令和产物恢复场景。
- [x] 先生成并按场景抽查 30 条黄金轨迹。
- [ ] 按论文及错误类型划分训练、验证和测试集，防止泄漏。
- [ ] 扩展到约 800～1200 条；只记录真实数量。
- [x] 运行格式、重复、泄漏和参数合法性检查后提交。

> 注记（2026-09-04）：已新增无第三方依赖的轨迹 Schema、递归路径/Token 脱敏、工具调用配对与未知工具校验；依据真实复现 smoke 记录 1 条真实轨迹，并确定性生成 29 条明确标记为 synthetic 的轨迹。`training/data/raw/golden.jsonl` 共 30 条，覆盖 6 类场景且全部通过校验。自动在线采集尚未开始。
>
> 注记（2026-09-04 数据均衡扩充）：修复评测指标口径后，为消除训练数据不均衡（原 141 决策中论文搜索/下载/仓库搜索/报告为 0 类、`__answer__` 语义混杂），将确定性生成器扩展为 14 类场景：新增 acquisition 流程（搜索→下载→仓库）、论文搜索 vs 当前论文证据检索意图区分、配置 vs 执行、校验修复 vs 报告、纯危险命令拒绝（不调工具）、无需工具直接回答、复现计划（有/无官方仓库）。**`golden.jsonl` 现为 181 条轨迹（180 synthetic + 1 real），经 `prepare_sft` 展开为 427 个下一步决策**，分布（2026-09-04 实测）：search_papers 32、download_paper 24、search_repositories 21、search_evidence 42、finalize_answer 34、plan_reproduction 16、configure_step 49、execute 34、verify 57、report 15、`__answer__` 103（24%），全部 11 类 ≥15、无 0 类。配套新增 `training/analyze_dataset.py`（展开分布统计）与 `eval/generate_cases.py`；**独立测试集 `eval/cases.json` 扩至 96 条**（保留原 12 条，新增 84 条分层变体，11 类每类 ≥6，含意图负样本对）。Schema 允许空工具列表（纯回答轨迹），危险命令样例在 build 前经脱敏（与既有流程一致）。步骤 164/165 仍未勾选：验证/测试集防泄漏拆分需在训练前正式划分（当前测试集与训练措辞不重复但同分布）；800～1200 条规模未达到——按已确认口径改为“展开后决策分布均衡”（427 决策）为准，后续可用真实会话日志替换/扩充。⚠️ 更正：1 条真实轨迹（scenarios/reproduction_error_repair_001.json）此前显示的“编码乱码”为工作区脏副本假象，HEAD 与 golden.jsonl 中均为正常中文，无清洗需求。

> 注记（2026-09-04 均衡数据训练对照）：保持第二轮训练配置不变（40 步 / max_length 1536 / lr 2e-4 / seed 42，trainable 10,092,544），仅把数据从 30 条轨迹（141 决策）换成 181 条轨迹（427 决策，本次均衡扩充）。训练：loss 0.5493，峰值显存 3.785GB，172.6s（training/outputs/qwen3-0.6b-lora-balanced；指标副本 eval/results/balanced/qwen3-0.6b-lora-training.json）。
>
> 评测（96 条分层测试集，eval/results/balanced/qwen3-0.6b-lora.json，温度 0）：动作准确率 79.17%（76/96）、参数匹配率 77.11%、Tool-needed F1 93.26%、JSON 合法率 95.83%。原 12 条子集同口径对照：动作准确率 50%→75%（6/12→9/12）、参数匹配率 45.45%→72.73%（5/11→8/11）——路由混淆显著缓解，验证“训练与运行时展示完整工具目录 + 决策分布均衡”方向有效。
>
> 分层统计显示残余系统性薄弱层：① refusal 类 0/7（评测语境为“检索已完成 hits=[]”时模型仍去调 research_search_evidence，而非 research_finalize_answer(insufficient_evidence)——训练示例中 finalize 决策前恒有 search 调用，评测缺少该上下文前缀）；② **answer** 1/13（危险命令“直接拒绝不调工具”与 command_constraint“configure→系统拒绝→换安全命令”两类标签在 configure 语境重叠，模型倾向调用工具）。二者为训练数据分布/评测格式与标签对齐问题，非代码缺陷，需下一轮数据精修（补“检索结果已在上下文”的 finalize 单步负样本；统一危险命令期望动作或拆分评测语境）。

## 第 11～12 天：LoRA 训练与接入

**新增：**

- `training/train_lora.py`
- `training/prepare_sft.py`
- `training/README.md`

**步骤：**

- [x] 核对 Transformers、PEFT、TRL、Accelerate 和 CUDA 环境。
- [x] 用 30 条轨迹展开的 141 个决策样本运行显存与保存/加载冒烟测试。
- [x] 根据 RTX 4060 8GB 和实验目标改用 Qwen3-0.6B、LoRA rank 16 训练。
- [x] 记录显存、耗时、Loss、随机种子和 Adapter。
- [ ] 通过本地 OpenAI 兼容接口让 Pi 可切换 Base/LoRA。
- [x] 验证 Base/LoRA 使用相同提示词、完整工具定义和固定测试集。

**降级：** 8GB 显存不足时缩短序列或减少批次，不改用无法真实训练的大模型。

## 第 13 天：Base/QLoRA 对照评测

**新增：**

- `eval/run_eval.py`
- `eval/metrics.py`
- `eval/cases/`
- `eval/results/`

**步骤：**

- [x] 固定 12 条独立诊断集、温度、最大输出和工具定义。
- [x] 分别运行 Base 与 LoRA 冒烟实验。
- [ ] 扩大独立测试集后计算工具选择、参数合法、报错恢复、拒答、引用和任务完成指标。
- [ ] 同时记录约束前模型指标与约束后系统指标。
- [x] 保存原始结果与汇总表，禁止人工挑选成功样例。
- [x] 对首轮失败案例分类并提交评测结果。

> 注记（2026-09-04）：Qwen3-0.6B Base 在 12 条诊断集上的动作准确率为 41.67%、参数匹配率为 36.36%、Tool-needed F1 为 62.50%。第一轮 LoRA 因训练时只暴露场景局部工具、运行时暴露完整目录而退化；修复分布不一致并保持 40 步训练后，动作准确率为 50.00%、参数匹配率为 45.45%；Tool-needed F1 按修正口径（输出含 <tool_call> 即计为工具尝试，含畸形 JSON）为 95.65%（原记录的 100% 系口径错误：危险命令样例输出了未转义 Windows 路径导致 JSON 解析失败，被误记为“未调用工具”，已于 2026-09-04 修复 `eval/metrics.py` 并从 raw_output 重算确认），JSON 合法率从 100% 降至 91.67%，且危险命令拒绝发生回退。因此该结果只证明训练链路和改进方向，不作为最终简历指标；下一阶段需补齐 acquisition、finalize、execute 和安全拒绝样本并扩大独立测试集。

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
