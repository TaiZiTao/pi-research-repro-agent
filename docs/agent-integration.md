# Qwen LoRA 正式接入(OpenAI 兼容 serve)

> 目的:让 Pi Agent 科研会话能把“工具决策”模型切换为本地 Qwen3-0.6B(+LoRA),由 Qwen 产出可执行的 tool_calls。Base/QLoRA 可切换,宿主与现有工具不变。

## 1. 启动服务(模型只加载一次)

```powershell
cd E:\deepseek\pi-desktop-research
# Base(无 LoRA)
python python/agent_shadow/qwen_openai_server.py --port 8123
# QLoRA(推荐;adapter 可用 answer-1.5 等已训产物)
$env:RESEARCH_QWEN_MODEL="E:\deepseek\models\Qwen3-0.6B"
$env:RESEARCH_QWEN_ADAPTER="E:\deepseek\pi-desktop-research\training\outputs\qwen3-0.6b-lora-answer-1.5\adapter"
python python/agent_shadow/qwen_openai_server.py --port 8123
```

就绪日志:`ready model=qwen3-0.6b adapter=True port=8123`。

## 2. 在 Pi Agent 中切换

- 模型设置新增/选择 OpenAI 兼容 provider:`api = openai-completions`,`baseUrl = http://127.0.0.1:8123/v1`;
- 模型 id:`qwen3-0.6b`(Base)或 `qwen3-0.6b-lora`(QLoRA);
- 把该模型设为科研会话模型后,Pi 会把 10 个科研工具 schema 发给本地服务,Qwen 返回 tool_calls 由 Pi 真实执行;不需要工具时 Qwen 输出纯文本(作为直接回答/拒绝)。

> 协议一致性:服务把首条 system 替换为评测用 SYSTEM_PROMPT(该 0.6B 是按“下一步工具决策器”训练的);请求未带 tools 时回退到评测目录的同一 TOOL_SCHEMAS,避免训练/运行漂移。

## 3. 验证(本仓库已跑通)

- 冒烟(QLoRA,answer-1.5):POST /v1/chat/completions → 200,`finish_reason=tool_calls`,`research_search_papers {query, limit:3}`,延迟约 2.1s(模型加载约 7s 一次性)。
- 转换:模型原生 `<tool_call>` 输出被解析并转换为 OpenAI `tool_calls`(name/arguments),可直接被 Pi 执行。

## 4. 边界与注意

- 0.6B 是“决策器”而非完整助手:多轮长程推理、最终润色建议仍由宿主负责;把本模型当整会话大脑会显著劣化。
- 端到端(真实 DeepSeek/Pi 会话切换后跑科研任务)需在桌面环境验证;本仓库验证到“OpenAI 协议 + 工具决策”层面。
- 服务串行处理单请求(GPU 单卡),显存约 3.8GB(QLoRA)/1.5GB(Base)。
