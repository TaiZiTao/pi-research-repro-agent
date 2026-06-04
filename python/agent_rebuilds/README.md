# Agent 重建复现产物(python/agent_rebuilds)

本目录存放"单论文科研复现 Agent"会话中重建/生成的模型代码,统一保存在 E 盘仓库工作区,
**不再默认写入 C 盘应用数据目录**。桌面应用(userData)下的同名文件仅为运行副本。

## dspfm_model.py — DSPFM 轻量超分(证据重建,无官方仓库)

- 来源:论文 `Lightweight Image Super-Resolution through Directional Structure Perception and Spatial-Frequency Cooperation`(匿名投稿,无官方开源);本文件为 **Agent 基于论文证据重建**,非官方代码;文件头逐条标注公式↔证据块号(p.X·chunk)与工程假设。
- 验证(本会话真实运行):内置冒烟 `D:\anaconda3\python.exe dspfm_model.py` 通过 → `parameters 619.1 K; LR (1,3,48,48) → SR (1,3,192,192); forward OK`。
- 修复记录(相对最初 Agent 输出,真实跑冒烟发现并修正):
  1. DirRPB 偏置表扁平索引越界:表为 `(2M-1,2M-1,Ha)`,索引按 0..(2M-1)² 一维取值 → 先 `reshape(-1, Ha)` 再索引(Swin 惯例);
  2. shift-window 注意力 mask 维度错位:`(1,nW,M²,M²)` 直接加 `(B·nW,Ha,M²,M²)` 报维度错 → attn 显式 view `(B,nW,Ha,…)` 后广播 mask 再加回。
- 边界:已验证 **forward 可跑**;未验证与论文语义等价、未训练/评估;工程假设(窗口/位移、pad、GN=8、SMM 用 torch.fft.fft2、MS-MLP 尾 GELU)均显式标注在文件头。
- 副本:E 盘独立目录 `E:\deepseek\repro-artifacts\dspfm_model.py`;桌面项目内副本 `%APPDATA%\Pi Agent Desktop\research\projects\ef5f741f-…\dspfm_model.py`(已同步修复版)。
