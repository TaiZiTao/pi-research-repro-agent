---
name: reproduction_execution
description: Execute a persisted reproduction plan with guardrailed commands, bounded repair, deterministic artifact verification, and an auditable report.
---

# Reproduction Execution

Run only when a reproduction plan exists for the current project.

1. Call `research_reproduction_execute` with `action=begin-run` once to start the run, then loop with `action=next-step` until it returns `done`.
2. A step with a `command` runs from the managed reproduction workspace with a bounded timeout; succeeded steps are never re-run. When a step returns `needs-agent`, call `research_reproduction_configure_step` for that current step with one allow-listed command, then continue with `next-step`.
3. Execution is guardrailed rather than container-sandboxed: commands are restricted by executable allow-list, traversal and shell-control checks, working directory and timeout. Never claim stronger isolation or a result that did not happen.
4. When a step fails, fix the cause, then call `research_reproduction_verify` with a bounded `reason` and `repair=true`. Repair is bounded to 3 rounds; beyond that the plan turns `blocked`.
5. When every step has succeeded, call `research_reproduction_verify` without an acceptance flag. Completion is decided from persisted status plus the real size and SHA256 of every execution log; pending, failed, missing or modified artifacts are rejected.
6. Finish with `research_reproduction_report`. The markdown must clearly state whether this is an Agent 最小复现 or the official repository, and covers the source, step exit codes, artifacts and failure explanations.
