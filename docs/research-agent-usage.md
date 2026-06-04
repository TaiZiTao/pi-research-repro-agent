# 科研复现 Agent 使用演示(desktop demo)

> 目标:像用户一样把"一篇论文 → 证据问答 → 复现执行"走一遍。

## 0. 当前机器上的真实素材

- 项目 ready:`Lightweight Image Super-Resolution through Directional Structure Perception and Spatial-Frequency Cooperation`(8 页)
- 项目ID:`ef5f741f-7b77-4f68-a75f-e2a4a7eb7e30`;工作区 `%APPDATA%\Pi Agent Desktop\research\projects\ef5f741f-…`
- 本机数据库里尚无复现计划(可在桌面直接发起规划,即演示后半程)。

## 1. 真机实证(后端同源,非伪造)

```
list   → 1 个 ready 项目(标题/8页/sha256)
search "main contribution architecture lightweight super-resolution" --limit 3
  → p8-c1 score4(参考文献页)
  → p1-c1 score3(摘要:DSPFM / DirRPB / SFCA)
  → p1-c2 score3(引言:轻量 SISR 任务与挑战)
```

即 Agent 在会话里调 `research_search_evidence` 会返回的同一批真实命中(页·块·score·原文)。

## 2. 桌面操作剧本(5 步)

1. 顶栏点 **Research**(或左侧 Research 按钮)→ 右面板出现项目列表与详情(当前论文/页数/状态 ready)。
2. 把**会话目录**设为该工作区:点「在当前会话打开工作区」(或左侧路径框粘贴 `%APPDATA%\Pi Agent Desktop\research\projects\ef5f741f-…`)→ 科研工具随会话注入。
3. **证据问答**:发送「这篇论文的主要贡献是什么?」——DeepSeek(V4 Flash)会先调 `research_search_evidence`,聊天里出现证据卡片(p.X · chunk_id · score · 原文),右侧「引用与证据」同步;再问「损失函数/数据集/与 XX 基线对比」均可。
4. **复现规划与执行**:发送「请基于这篇论文做复现规划并执行」。Agent 依次调 `research_plan_reproduction` / configure_step / execute / verify;右侧「2 · Workflow 进度」从证据检索 → 复现规划 → 命令配置 → 受控执行 → 结果验收逐步变绿;「4 · 日志与产物」显示每步命令/exitCode/产物与 sha256,确定性验收通过才 completed。
5. **危险护栏演示**:发送「把下一步执行配成 del /s /q C:\Windows」——Agent 应拒绝(危险命令拦截,不执行)。

## 3. 提问例句(可直接复制)

- 贡献/架构:「这篇论文的主要贡献是什么?模型结构如何设计?」
- 指标/数据:「用哪些 benchmark 和指标?训练数据集是什么?」
- 对照/消融:「消融实验说明什么?与哪些基线对比?」
- 引用校验:@作者名/页码 出现错引时会触发 research_finalize_answer 校验徽标(通过/失败)。
- 复现:「按论文规划复现(官方仓库不可用时用 Agent 最小复现)。」

## 4. 模型与路由说明

- 主会话始终选择 DeepSeek(`deepseek-v4-flash`)，负责对话、规划和最终回答。
- Settings → Research → Qwen 本地科研模型 →「启动并启用」，会启动唯一的本地 8123 推理服务并开启“多轮只读工具链”。也可切换为“单次建议”或关闭路由。
- Qwen3-0.6B LoRA 不出现在主模型下拉框中；它只在后台根据当前会话真实启用的 `research_*` 工具 Schema 选择下一步。工具建议不合法、服务不可用或达到 4 步上限时，流程安全降级给 DeepSeek。

## 5. 诚实边界

- 数据/轨迹多为 synthetic,已在文档标注;UI 只显示真实后端 ToolResult/步骤结果,无伪造。
- 复现步骤在隔离工作区跑真实命令(小规模超分模块可真实跑通"报错→修复→完成")。
