# Pi Research Reproduction Agent

> 单论文科研复现 Agent:喂一篇论文 PDF,它替你完成"读懂 → 证据问答 → 受控代码复现"。
> 基于 Pi Agent Desktop 二次开发;**DeepSeek 负责对话与规划,Qwen3-0.6B LoRA 负责后台工具路由**。

---

## 一、它解决什么问题

把一篇 AI 论文变成可运行的复现代码,通常要人工做四件事:

1. **读懂论文**:方法、损失、训练配置、评测结果各在论文哪一页;
2. **找依据**:回答"这篇论文用什么损失/数据集/指标"时,能给出**页码级证据**,而不是凭印象;
3. **做复现**:有官方仓库就按代码跑,没有官方仓库就照论文重建;
4. **保证安全与可信**:命令不乱跑、产物有校验、引用不编造。

这个 Agent 把以上四件事做成一条自动化流水线,并提供桌面 GUI 实时观察每一阶段。

---

## 二、整体架构(三层分工)

### 1) 知识侧 —— 论文证据检索(Hybrid RAG)

- PyMuPDF 分页抽取文本,切成确定性 Chunk 并绑定 `paper_id / page / chunk_id`;
- **双路召回 + RRF 融合**:多语言 e5 稠密向量(faiss 余弦)+ BM25 稀疏检索;
- 命中证据返回真实 `page / chunk / score`,支持逐条溯源到原文;
- Citation Verify 只放行"确实来自检索命中块"的引用——**回答必须可回查原文**。

### 2) 决策侧 —— DeepSeek 主模型 + Qwen 工具路由

- 主会话模型始终是 **DeepSeek**(理解、规划、终答、复杂参数);
- 本地 **Qwen3-0.6B LoRA**(FP16 微调,257 轨迹 / 511 决策样本)作为后台工具路由器;
  可切换三种模式:关闭 / 单次建议 / 多轮只读工具链;
- 路由安全约束:决策只对"当前会话真实启用的 research_* 工具"生效、最多 4 步、
  状态变更类工具仍由 DeepSeek 经宿主门禁执行。

### 3) 执行侧 —— 8 阶段复现 Workflow

论文获取 → 内容解析 → 证据检索 → 仓库检验 → 复现规划 → 命令配置 → 受控执行 → 结果验收;
支持双路径:有官方仓库则执行代码计划,**无官方仓库则 Agent 照论文重建**;
失败自动修复 ≤3 轮;产物以 SHA256 确定性验收;危险命令与越界 Schema 在宿主侧拦截。

---

## 三、桌面端长什么样

三栏布局:左侧会话与目录,中央聊天(始终显示 DeepSeek),右侧文件/浏览器/进程/**Research** 页签。

- Research 面板可:**在线搜索论文 → 一键下载并导入项目**(arXiv/OpenAlex 开放 PDF);
- 证据问答:Agent 调用 `research_search_evidence`,聊天中展示 `p.X · chunk_id · score · 原文`;
- 复现进行时:Workflow 进度逐步变绿,日志与产物区显示每步命令 / exitCode / 产物 sha256;
- 点击证据页码可直接打开 PDF 定位(浏览器原生预览的 `#page` 锚点,best-effort)。

> 截图/演示脚本:`docs/research-agent-usage.md`(5 步演示剧本,可直接照着操作)。

---

## 四、目录导览

```
src/                       # Electron 桌面端 + agent-host 科研运行时 + RPC 契约
python/paper_worker/      # PDF 解析、Hybrid RAG(embedding/retriever/fusion/keyword)
training/                 # 决策数据生成、Schema 校验、LoRA 训练与评测管线
eval/                     # 111 条工具决策评测、36 条证据检索标注与结果(含口径说明)
python/agent_rebuilds/    # 无官方仓库时的 Agent 重建代码示例(DSPFM 超分模型)
docs/                     # results.md(完整实验归档)、research-agent-usage.md(演示)
mcp/research-acquisition/ # arXiv/OpenAlex/GitHub 检索下载服务
```

---

## 五、快速开始

**环境要求**:Node 20+/npm、Python 3.10+(pymupdf / faiss / sentence-transformers)、推荐 CUDA。

```bash
# 1) 构建桌面端(main + renderer)
npm install
npm run build

# 2) 启动
npm start    # 或 npm run dev

# 3) 科研数据/评测(可选)
python -m training.validate_dataset training/data/raw/golden.jsonl
python eval/run_eval.py --model <qwen路径> --adapter <lora>/adapter --output-dir eval/results/x
```

桌面内使用流程见 `docs/research-agent-usage.md`。

---

## 六、评测结果(口径与文件)

| 对象     | 内容                                                                                                        | 位置                   |
| -------- | ----------------------------------------------------------------------------------------------------------- | ---------------------- |
| 工具决策 | 111 条分层评测:Base→refined 动作 48.65→72.97%、参数 33.73→87.95%;over-tool 对抗动作 81.08%、over-tool 3.57% | `eval/results/`        |
| 证据检索 | 36 条自然语言问题(封闭同源 8 篇):Hit@1 55.6%、Hit@5 75%、MRR 0.62                                           | `eval/rag-eval-2026.*` |

> 全部为真实运行结果;口径与局限(封闭同源、中文弱匹配、合成数据标注)见各文件说明,不粉饰。

---

## 七、边界与致谢

- 训练数据为确定性生成 + 少量真实,已显式标注 synthetic;
- 无官方仓库时的"重建"是 Agent 依据论文证据的实现(如 `python/agent_rebuilds/`),非官方代码;
- 本项目基于上游 Pi Agent Desktop 二次开发,上游代码与许可归其原项目所有。
