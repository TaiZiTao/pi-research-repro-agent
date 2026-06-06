# Job Showcase README Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the brief repository README with a Chinese, recruiter-friendly project page that foregrounds the Agent engineering contribution and keeps every claim traceable to repository evidence.

**Architecture:** Keep `README.md` as the single landing page and reuse the existing screenshot plus GitHub-native Mermaid diagrams. Present value and evaluation first, then progressively disclose model roles, workflow, retrieval, execution safeguards, setup, limitations, and upstream attribution; link detailed evidence to existing repository documents instead of duplicating it.

**Tech Stack:** Markdown, GitHub Mermaid, Electron, React, TypeScript, Python, MCP, DeepSeek, Qwen3-0.6B, LoRA, Dense retrieval, BM25.

---

## File map

- Modify: `README.md` — the recruiter-facing repository landing page.
- Reference: `docs/results.md` — source of truth for evaluation values and implementation boundaries.
- Reuse: `docs/screenshot-research.png` — product screenshot embedded in the README.
- Reference: `package.json` — source of truth for supported npm scripts.
- Reference: `training/data/splits/split_manifest.json` — source of truth for trajectory and evaluation split counts.
- Reference: `resources/research-skills/*/SKILL.md` — source of truth for the three research skills.

### Task 1: Build the evidence-backed content map

**Files:**

- Read: `README.md`
- Read: `docs/results.md`
- Read: `package.json`
- Read: `training/data/splits/split_manifest.json`
- Read: `resources/research-skills/paper_analysis/SKILL.md`
- Read: `resources/research-skills/reproduction_planning/SKILL.md`
- Read: `resources/research-skills/reproduction_execution/SKILL.md`

- [ ] **Step 1: Confirm the top-level product claims**

Record only claims supported by the files above:

- DeepSeek is the main dialogue, reasoning, planning, and code-generation model.
- The LoRA-tuned Qwen3-0.6B participates as a local tool router.
- The workflow covers paper acquisition, parsing, evidence retrieval, repository inspection, reproduction planning, command preparation, controlled execution, and artifact verification.
- The repository contains three research Skills and an MCP acquisition service.

- [ ] **Step 2: Confirm the evaluation pair used in the README**

Use the same 111-case evaluation protocol for both rows:

| Metric          | Base model | Final router |
| --------------- | ---------: | -----------: |
| Action accuracy |     48.65% |       81.08% |
| Over-tool rate  |     25.00% |        3.57% |

Do not combine the 72.97% refined checkpoint action score with the 3.57% over-tool score from another checkpoint.

- [ ] **Step 3: Confirm the honesty boundaries**

The final README must state or preserve these boundaries:

- The documented end-to-end repair example is a small super-resolution module, not a multi-paper success-rate study.
- SHA256 verifies artifact integrity, not scientific correctness.
- Qwen autonomous chaining is limited to active read-only research tools.
- The latest-event view is process-local rather than a persistent cross-restart audit store.
- PDF page jumps are best effort and viewer-dependent.

### Task 2: Rewrite the recruiter-facing landing page

**Files:**

- Modify: `README.md`

- [ ] **Step 1: Replace the opening with a clear value proposition**

The opening must contain:

```markdown
# Pi Research Reproduction Agent

面向科研论文代码复现的桌面端 Coding Agent。系统以 DeepSeek 负责推理、规划与代码生成，以 LoRA 微调的 Qwen3-0.6B 参与本地工具决策，将论文证据检索、复现规划、受控执行、错误修复与产物验收串成可观测工作流。
```

Follow it with four short highlights: eight-stage workflow, evidence-grounded retrieval, dual-model routing, and controlled execution.

- [ ] **Step 2: Add evaluation and product evidence near the top**

Add the fixed comparison table from Task 1, explain that lower over-tool rate is better, and embed:

```markdown
![科研论文复现工作台](docs/screenshot-research.png)
```

- [ ] **Step 3: Add architecture and workflow diagrams**

Use Mermaid diagrams that show:

```text
User -> Pi Agent Desktop -> DeepSeek main model
DeepSeek -> Research Skills / MCP / paper retrieval / controlled executor
DeepSeek -> Qwen tool router -> read-only research tools
Executor -> repair loop -> artifact verification
```

The workflow diagram must list all eight stages and a bounded repair loop of at most three rounds.

- [ ] **Step 4: Explain the four technical pillars**

Create compact sections for:

1. DeepSeek/Qwen model-role boundary;
2. MCP and the three Research Skills;
3. PDF page parsing with Dense+BM25 retrieval and traceable metadata;
4. Schema/path/command/secret/timeout safeguards and artifact integrity checks.

Each section must connect technology to its purpose instead of listing names alone.

- [ ] **Step 5: Document training and evaluation transparently**

State that 257 trajectories were expanded into 511 decision samples and that the fixed evaluation contains 111 cases. Link full metrics and protocol to `docs/results.md`, and mention that dataset splitting excludes exact prompt overlap.

- [ ] **Step 6: Add practical setup and repository navigation**

Use commands already defined by the repository:

```powershell
npm install
npm run rebuild:native
npm run dev
```

Document the optional local router and point advanced users to existing training/evaluation scripts without inventing new commands. Add a concise directory tree covering `src`, `mcp/research-acquisition`, `python/paper_worker`, `resources/research-skills`, `training`, `eval`, and `docs`.

- [ ] **Step 7: Add limitations and attribution**

Clearly distinguish this repository's research-reproduction additions from upstream Pi Agent Desktop. Preserve the repository license statement and list current limitations from Task 1.

### Task 3: Verify the finished README

**Files:**

- Verify: `README.md`

- [ ] **Step 1: Run formatting and whitespace checks**

Run:

```powershell
npx prettier --check README.md
git diff --check
```

Expected: Prettier reports the file is formatted and Git reports no whitespace errors.

- [ ] **Step 2: Validate local links and image targets**

Extract relative Markdown links from `README.md` and confirm that every local target exists. At minimum these paths must resolve:

```text
docs/screenshot-research.png
docs/results.md
docs/research-agent-usage.md
resources/research-skills/paper_analysis/SKILL.md
resources/research-skills/reproduction_planning/SKILL.md
resources/research-skills/reproduction_execution/SKILL.md
```

- [ ] **Step 3: Validate scripts and numerical claims**

Check every shown npm command against `package.json`, then search `docs/results.md` and the evaluation summaries for the values `48.65`, `81.08`, `25.00`, and `3.57`.

Expected: every command exists and each headline number has a repository source.

- [ ] **Step 4: Review recruiter readability and truthfulness**

Confirm that a reader can identify the project value, personal contribution, and final metrics before the setup section. Confirm that the README does not claim multi-paper end-to-end success, scientific correctness from SHA256, or full autonomy for Qwen.

- [ ] **Step 5: Commit the README**

Run:

```powershell
git add README.md
git commit -m "docs: expand README for project showcase"
```

Expected: one documentation commit containing only `README.md`.
