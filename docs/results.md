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
