---
name: reproduction_planning
description: Plan a single-paper code reproduction from ready evidence; extract repository hints, datasets, metrics and training configuration, then decide between the verified official repository and an explicitly labeled agent reproduction.
---

# Reproduction Planning

Work only on the paper bound to the current project after its evidence chunks are ready.

1. Call `research_plan_reproduction` to create and persist a reproduction plan for the current paper. The reply carries the bounded summary (`planId`, status, `stepCount`, `agentReproduction`, repository, notes); the persisted plan holds the step template and the extraction (datasets, metrics, training hints).
2. Provide `repositoryUrl` (https, together with `matchBasis` and optionally `commitSha`/`license`) only when the official repository was actually verified against the paper. Without a verified repository the plan is an Agent 最小复现, notes say it never claims to be official, and the first step scaffolds an agent module instead of cloning.
3. Never invent a repository, dataset, metric, hyperparameter or training configuration that the evidence does not support.
4. When the plan exists, continue with Reproduction Execution.
