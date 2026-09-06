# Research Core Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing MCP and reproduction modules callable by the real Agent and prevent incomplete runs from being reported as completed.

**Architecture:** Keep the current modules. Add a small runtime-owned service bundle and session tool assembler, extend reproduction steps with an explicit configuration/submission path, and replace model-authored acceptance with deterministic state and artifact checks. Execution remains guardrailed host execution, not a security sandbox.

**Tech Stack:** TypeScript, Pi Agent tools, MCP SDK, SQLite, Node filesystem/crypto/process APIs.

---

### Task 1: Wire research tools into Agent sessions

**Files:**

- Create: `src/agent-host/research/session-tools.ts`
- Create: `src/agent-host/research/session-tools.test.mjs`
- Modify: `src/agent-host/research/runtime.ts`
- Modify: `src/agent-host/rpc-manager.ts`

- [ ] Write a failing test proving acquisition tools are available globally and reproduction tools are added only for a ready project.
- [ ] Run `node --test src/agent-host/research/session-tools.test.mjs` and confirm the factory is missing.
- [ ] Add a pure session tool assembler and runtime-owned acquisition client/reproduction store.
- [ ] Replace the direct `createResearchTools` call in `rpc-manager` with the assembled tool list.
- [ ] Re-run the focused test and commit.

### Task 2: Make pending reproduction steps actionable

**Files:**

- Modify: `src/agent-host/research/reproduction/types.ts`
- Modify: `src/agent-host/research/reproduction/reproduction-tools.ts`
- Modify: `src/agent-host/research/reproduction/reproduction-tools.test.mjs`

- [ ] Write a failing test for `research_reproduction_configure_step` attaching a bounded command to the current pending step.
- [ ] Confirm the test fails because the tool does not exist.
- [ ] Add the tool; reject non-current steps, oversized commands, shell chaining, and commands outside the executable allow-list.
- [ ] Execute the configured step through the existing runner and confirm it becomes succeeded with a log.
- [ ] Re-run the focused test and commit.

### Task 3: Deterministically verify completion and artifacts

**Files:**

- Create: `src/agent-host/research/reproduction/verifier.ts`
- Create: `src/agent-host/research/reproduction/verifier.test.mjs`
- Modify: `src/agent-host/research/reproduction/executor.ts`
- Modify: `src/agent-host/research/reproduction/reproduction-tools.ts`
- Modify: `src/agent-host/research/reproduction/report.ts`

- [ ] Write failing tests proving pending/failed steps cannot complete and modified or missing logs are rejected.
- [ ] Confirm failures reproduce the current false-completion behavior.
- [ ] Hash command logs, store their byte count/SHA256, and validate them beneath the artifacts root.
- [ ] Remove the model-supplied `accepted` field; compute acceptance from persisted steps and artifacts.
- [ ] Preserve the three-round repair path for actual failed steps.
- [ ] Re-run reproduction tests and commit.

### Task 4: Real trajectory smoke and wording

**Files:**

- Modify: `resources/research-skills/reproduction_execution/SKILL.md`
- Modify: `docs/superpowers/plans/2026-09-03-research-reproduction-agent.md`

- [ ] Run the focused MCP/research/reproduction tests and TypeScript typecheck.
- [ ] Run one local trajectory: plan → configure → fail → repair → configure/fix → succeed → deterministic verify → report.
- [ ] Confirm the real session tool assembler exposes MCP, evidence, CitationVerify, and reproduction tools in the correct contexts.
- [ ] Replace “sandbox” claims with “受控执行/guardrailed execution” and record the real smoke evidence.
- [ ] Commit the verified slice.
