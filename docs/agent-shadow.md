# Qwen LoRA 影子模式(Shadow Mode)

> 状态:本阶段只实现 shadow(旁路预测),不替换宿主 DeepSeek;`off` 默认,零影响。

## 是什么

科研 Agent 会话里,宿主(DeepSeek)仍是唯一决策者。每轮 assistant 回复产出后,agent-host 把同一轮对话状态(最近 ≤4 条)+ 与训练/评测一致的 10 工具目录与 System Prompt 异步发给本地常驻的 Qwen3-0.6B LoRA worker,预测“下一步动作/参数”,并与 DeepSeek 实际动作对比,写入 JSONL。Qwen 只预测,不执行工具、不影响输出;任何异常静默回退。

## 配置(环境变量,进程启动时读取一次)

| 变量                    | 取值                  | 说明                                 |
| ----------------------- | --------------------- | ------------------------------------ |
| `RESEARCH_QWEN_MODE`    | `off`(默认)/ `shadow` | `off` 完全不加载模型、不 spawn       |
| `RESEARCH_QWEN_MODEL`   | 基础模型路径          | 默认 `E:\deepseek\models\Qwen3-0.6B` |
| `RESEARCH_QWEN_ADAPTER` | LoRA adapter 路径     | shadow 下必填;缺失则静默不开         |
| `RESEARCH_QWEN_LOG`     | JSONL 日志路径        | shadow 下建议必填,否则不落盘         |
| `RESEARCH_QWEN_PYTHON`  | Python 解释器         | 默认 `D:\anaconda3\python.exe`       |

> 暂不提供让 Qwen 直接控制工具的模式(未实现)。

## 记录内容(JSONL,每轮一条)

- `ts`、`sessionHash`(会话 ID 的 SHA-256 前 16 位,匿名化)
- `qwen`:`{ action, arguments(脱敏), jsonValid, latencyMs }`,失败为 `null`
- `deepseek`:`{ action, arguments(脱敏) }`(尽力提取,失败为 `null`)
- `match`:两侧动作是否一致(`null` 当任一侧缺失)

不记录密钥、论文全文与本地路径:arguments 中 token/路径一律替换为 `[redacted-token]` / `[redacted-path]`。

## 文件

- `python/agent_shadow/qwen_shadow_worker.py` — 常驻 stdio worker(模型只加载一次;import eval 的 TOOL_SCHEMAS/SYSTEM_PROMPT/metrics.parse_decision)
- `src/agent-host/research/qwen-shadow.ts` — 配置/进程生命周期/协议/脱敏/JSONL/纯函数
- `src/agent-host/research/qwen-shadow.test.mjs` — 7 项单测(off/影子/异常回退/脱敏/单例)
- `src/agent-host/rpc-manager.ts` — `attachShadowObserver`(每轮 message_end 旁路)

## 手动验证

真 worker 冒烟:

```
cd E:\deepseek\pi-desktop-research
node .artifacts/shadow-smoke.mjs
```
