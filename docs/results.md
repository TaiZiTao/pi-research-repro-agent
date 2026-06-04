# 科研复现 Agent — 结果归档(results.md)

> 归档日期:2026-09-04 · 分支 feature/research-paper-analysis · 数据与结果文件均在仓库内,可复核。

## 1. 系统模块(已提交,详见 docs/superpowers/plans 注记与各 commit)

- Workflow:复现状态机 planned→…→completed/blocked;隔离工作区、危险命令拦截、超时、断点、≤3 轮修复、产物 SHA256 确定性校验;小型超分模块真实跑通“报错→修复→完成”。
- MCP + Skills:论文搜索(arXiv+OpenAlex 聚合去重)、开放 PDF 下载(魔数/类型/大小/哈希)、GitHub 仓库检索;3 个 Skill;真实端到端下载 PDF(sha256 与导入一致)。
- RAG:PyMuPDF 按页切块 + BM25/向量/RRF 融合(可降级);修复 UTF-16 切块缺陷。
- 约束:CitationVerify(paper_id/page/chunk_id+原文)、Schema 越界拒绝、危险命令/路径/Token 脱敏、Agent 最小复现标注。

## 2. QLoRA 工具决策器实验

### 2.1 评测协议(最终口径,metrics.py)

- 111 条分层测试集:eval/cases.json(需要工具 83 / 不需要工具 28×5 类);temperature 0,同提示词同工具目录。
- 指标:action_accuracy / argument_match_rate / tool_needed_f1 / **over_tool_rate**(该拒答时仍调用的比例);畸形 `<tool_call>` 一律计为工具尝试(口径修复 commit e4b2828)。

### 2.2 Base vs QLoRA(本会话实测,111 条)

| 版本                            | 动作准确率 | 参数匹配率 | Tool-needed F1 | Over-tool Rate | 结果文件                                      |
| ------------------------------- | ---------- | ---------- | -------------- | -------------- | --------------------------------------------- |
| Base                            | 48.65%     | 33.73%     | 58.27%         | 25.00%         | eval/results/base111/qwen3-0.6b-base.json     |
| refined(数据精修两轮)           | 72.97%     | 87.95%     | 86.01%         | 96.43%         | eval/results/refined111/qwen3-0.6b-lora.json  |
| over-tool 对抗(171 步+answer×2) | 81.08%     | 61.45%     | 98.18%         | 3.57%          | eval/results/overtool111/qwen3-0.6b-lora.json |

原 12 条诊断集(同口径,Base→refined):动作 41.67%→91.67%、参数 36.36%→90.91%。

### 2.3 失败对照与教训(全部保留,不删除)

- 第一轮(训练只见局部工具、运行全量)退化至 25% → 根因:训练/运行工具目录不一致;修正为完整 10 工具目录。
- 指标口径:畸形 tool_call 曾漏计 fp(100% F1)→ 修正后 95.65%(commit e4b2828)。
- refined 学会工具协议但过度调用(Over-tool 96.43%);answer 2× 上采样压制后 Over-tool 3.57% 但参数率与 finalize/execute 受损 → 平衡点未最终收敛(见下)。
- 参数失败主因示例:research_search_papers 的 limit——评测要求 2/3/4,训练几乎全为 5。

### 2.4 平衡点与后续(v2 实验另行归档)

answer 1.5× 上采样与 eval split 隔离、fp16 验证等由后续 commit 记录:cdd36c0(eval splits + fractional answer sampling)、7c19d04(fp16 lora validation/blind)、eb6b53d/c2f8398(hard-case v2 设计与计划)。本表未包含未经本会话复核的数字;最终简历口径以定稿评测为准。

## 3. Qwen 接入(commit df80324 影子旁路;e76xxxx 起 OpenAI 兼容 serve 正式可用)

- off/shadow 两态(env RESEARCH_QWEN_MODE,默认 off 不加载);每轮 assistant 回复后异步旁路预测,DeepSeek 唯一决策者,Qwen 异常静默回退;JSONL 对比记录(会话匿名哈希、参数脱敏、不落论文全文)。
- 验证:TS 单测 7/7;真机冒烟 answer-1.5 加载 ~6.5s、单条预测 ~1.8s、返回 research_search_papers{query,limit:3}。
- 正式接入:python/agent_shadow/qwen_openai_server.py 提供 OpenAI 兼容 /v1/chat/completions(Base/QLoRA 可切),把 <tool_call> 转成 OpenAI tool_calls 供 Pi 真实执行;冒烟验证返回 research_search_papers{query,limit:3}(~2.1s)。Pi 侧配置见 docs/agent-integration.md;端到端桌面会话验证待真机。

## 4. 复现命令

```
# 数据(重建与统计)
cd E:\deepseek\pi-desktop-research
$env:PYTHONPATH="."
python -m training.build_dataset
python -m training.validate_dataset training/data/raw/golden.jsonl
python training/analyze_dataset.py training/data/raw/golden.jsonl
# 训练(例:refined 同参数 40 步)
python training/train_lora.py --model E:\deepseek\models\Qwen3-0.6B --data training/data/raw/golden.jsonl --output training/outputs/<tag> --max-steps 40 --max-length 1536
# 评测(111 条分层)
python eval/run_eval.py --model E:\deepseek\models\Qwen3-0.6B [--adapter training/outputs/<tag>/adapter] --output-dir eval/results/<tag>
# 单测
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test --test-timeout=120000 src/agent-host/research/qwen-shadow.test.mjs
python training/tests/test_dataset_pipeline.py && python training/tests/test_prepare_sft.py && python eval/tests/test_metrics.py
```

## 5. 关键 commit 索引

- 数据均衡/评测分层: e68c3a1 · 9ffdf89 · 194f3d2 · cc713b5 · 5577a63
- 指标口径修复: e4b2828
- 训练脚本与基线: 003a96c · f08b8b7
- 影子模式: df80324
- v2/fp16(用户侧): cdd36c0 · 7c19d04 · eb6b53d · c2f8398

## 6. 桌面端科研演示(commits d928f87 / 41b3e90 / 42a61fc)

- 入口:侧栏 Research 按钮(或右面板 Research 页签)→ 右侧面板 Research 页;Research Panel 已并入 files/browser/processes 右侧 tab 体系(Explorer / Browser / Processes / Research),不再是右滑 overlay;设置页 Research tab 亦可。
- PDF 导入(piBridge.selectPdfFile → research.import)→ 项目列表;「在当前会话打开工作区」= handleCwdChange(workspacePath),科研工具随会话注入。
- 论文候选卡片:research_search_papers ToolResult 渲染(标题/作者/年份/来源/摘要展开/PDF可用);「选择此论文」经 window 事件送入输入框 → Agent 调 research_download_paper(保留先展示-用户选择-再下载门禁)。
- 在线搜索+一键导入(新):面板 Section「0 · 在线搜索论文」输入关键词 → research.papers.search(经 acquisition client 真网搜 arXiv/OpenAlex)→ 候选列表每项「下载并导入」→ research.papers.import(下载到受管 downloads 根目录 → importPdf 自动建项目并选中);live smoke 3 条真实候选 ~1.6s。
- 证据与校验:research_search_evidence 证据行、research_finalize_answer 校验徽标(对话内 + 经 pi:evidence / pi:finalize 事件实时聚合到 Research Panel「引用与证据」区,含 p.X · chunk_id · score · 原文);证据 p.X 可点击、「当前论文」区「打开 PDF」——research.detail 现暴露 managedPdfPath 并授予项目根目录文件访问,在 FileViewer 中打开 PDF 并带 #page=N 锚点(best-effort;Electron 原生 PDF 预览不保证翻页,未引入 pdf.js)。
- Research Panel 四区:当前论文(标题/页数/状态/ID/工作区/SHA256/错误)、8 阶段 Workflow(pending/running/succeeded/failed/blocked;仅 ready/completed 显示成功)、引用与证据、日志与产物(顶部「最近动态」时间线:PDF 导入进度 copying/parsing/indexing/complete/failed + 复现计划创建/阶段/步骤状态变迁/完成/阻塞,带时间戳与状态色点;下方步骤含 exitCode/artifactRef/artifactBytes/artifactSha256/repairRoundsUsed;确定性验收通过才 completed);detail 轮询 3s。
- 后端接口:research.detail {projectId} → {project(含 managedPdfPath), reproduction|null, recentEvents};research.qwen.status/start/stop;research.papers.search {query,limit} / research.papers.import {pdfUrl,title}。
- 测试:research 全套(含 event-log 6、qwen-tools 3、qwen-server 3、handlers 计数 89)、mapping 7/7、file-tab-state;tsc main+renderer 0、eslint 0、契约覆盖通过。
- 截屏:docs/screenshot-research.png(主界面;面板交互页需在运行窗口操作后另截)。
- 降级:recentEvents 为进程内环形账本(每项目上限 200、进程生命周期内有效,跨进程重启不保留;非 SQLite 持久化);PDF 页码定位为 #page=N best-effort(原生 PDF 预览不支持脚本化翻页,未引入 pdf.js);导入后打开=handleCwdChange(不会自动新建会话点击)。

## 7. Qwen 本地工具路由器(架构修正)

- 定位修正:Qwen3-0.6B LoRA 是**本地工具决策器**,不是主会话模型;主模型始终 DeepSeek(对话/理解/复现规划/复杂参数/终答)。曾错误地允许 research-qwen 作为主模型被选中(会话被 Qwen 接管 → 决策器提示引导连发工具、活动工具为空/服务端补静态目录 → Tool not found 无限重试)。
- 修复(本轮):research-qwen 移出主 models.json 与模型下拉;AgentSessionWrapper.set_model 对 research-qwen 抛错拒绝;设置页移除「写入模型配置」;服务端**显式 tools 列表原样使用、空列表不补静态 10 工具**(仅缺省时才用 eval 目录兜底供直连演示)。
- 路由模式(env RESEARCH_QWEN_ROUTER=1 + RESEARCH_QWEN_ADAPTER,默认关闭):每次普通用户消息前,qwen-router(复用 qwen-shadow worker)用最近会话+新消息预测下一步——**answer**/无效/建议不在活动工具集/非 research_* 一律不加指令;通过校验的建议转成 steer 前缀交给 DeepSeek 执行真实工具并据实作答。消息入口只建议一次,杜绝 not-found 死循环;建议落空即原样放行。
- 执行与安全:工具执行、finalize/configure/execute/download 等复杂参数与状态变更全部由 DeepSeek 经宿主安全门禁完成;Qwen 只参与"要不要/哪个/简单参数"的决策,不执行。
- 服务:8123 OpenAI 兼容 + SSE(内容块 + finish_reason + [DONE]),/v1/models 探测;设置页 Research 提供启停与状态(不再写主模型目录)。
- 测试:qwen-router 4/4(建议过滤/活动集校验/steer 前缀)、qwen-tools 3/3;双 tsc/eslint 通过。

## 8. 训练数据均衡(evidence limit)

- 现象:research_search_evidence 的 limit 参数训练几乎全为 5(唯一例外 1 条 3);评测侧 evidence 查询可能要求其他取值 → 参数匹配率受损。
- 修复:training/generate_golden.py 引入全局轮换 _EVIDENCE_LIMIT_CYCLE=(5,3,8),每个 research_search_evidence 调用依次取下一值(确定性)。
- 数据集(257 轨迹)重建后统计:research_search_evidence 调用 42 次,limit 3/5/8 = 14/14/14(原 41×5 + 1×3);validate_dataset 通过。
- 对照实验(40 步 balanced-v2,本会话真实运行):action 70.27% / argument 84.34% / tool-needed F1 86.91% / over-tool 89.29%;文件 eval/results/balanced-v2/qwen3-0.6b-lora.json。与 refined(72.97/87.95/86.01/96.43)相比动作准确率基本持平、参数率略降;over-tool 仍高(该 40 步对照未叠加 answer 上采样),记录为平衡点在 limit 维度收敛的第一步,未宣称更好。
