---
name: reproduction_execution
description: Execute a persisted reproduction plan inside the isolated reproduction workspace with bounded repair, verify the run, and render the reproduction report.
---

# Reproduction Execution

Run only when a reproduction plan exists for the current project.

1. Call `research_reproduction_execute` with `action=begin-run` once to start the run, then loop with `action=next-step` until it returns `done`.
2. A step with a `command` runs inside the isolated reproduction workspace with a bounded timeout; succeeded steps are never re-run (breakpoint resume). Steps whose `command` is missing return `needs-agent` and stay `pending`: the Agent must complete them from the paper or from the failing errors, and retry instead of pretending they ran.
3. Commands only run inside the isolated reproduction workspace; destructive commands are rejected. Never claim a result that did not happen.
4. When a step fails, fix the cause, then call `research_reproduction_verify` with `accepted=false`, a bounded `reason` and `repair=true` to reset failed steps and start another round. Repair is bounded to 3 rounds; beyond that the plan turns `blocked`.
5. When the run is complete, call `research_reproduction_verify` with `accepted=true` to finish with `completed`.
6. Finish with `research_reproduction_report`. The markdown must clearly state whether this is an Agent 最小复现 or the official repository, and covers the source, step exit codes, artifacts and failure explanations.
