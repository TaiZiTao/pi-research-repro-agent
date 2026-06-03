import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { ReproductionPlan } from "./types.ts";

export interface ReproductionVerification {
  accepted: boolean;
  errors: string[];
  invalidStepIds: string[];
}

function artifactPath(root: string, reference: string): string | undefined {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, reference);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
  return resolved;
}

/** Verify completion from persisted state and real artifact bytes, never model judgement. */
export function verifyReproductionPlan(plan: ReproductionPlan, artifactsRoot: string): ReproductionVerification {
  const errors: string[] = [];
  const invalid = new Set<string>();
  for (const step of plan.steps) {
    if (step.status !== "succeeded" && step.status !== "skipped") {
      errors.push(`${step.id} is ${step.status}`);
      invalid.add(step.id);
      continue;
    }
    if (step.status === "skipped") continue;
    if (step.exitCode !== 0 || !step.artifactRef || !step.artifactSha256 || step.artifactBytes === null) {
      errors.push(`${step.id} has incomplete execution evidence`);
      invalid.add(step.id);
      continue;
    }
    const fullPath = artifactPath(artifactsRoot, step.artifactRef);
    if (!fullPath) {
      errors.push(`${step.id} artifact escapes the managed root`);
      invalid.add(step.id);
      continue;
    }
    try {
      const stat = statSync(fullPath);
      const content = readFileSync(fullPath);
      const sha256 = createHash("sha256").update(content).digest("hex");
      if (!stat.isFile() || stat.size !== step.artifactBytes || sha256 !== step.artifactSha256) {
        throw new Error("artifact mismatch");
      }
    } catch {
      errors.push(`${step.id} artifact is missing or modified`);
      invalid.add(step.id);
    }
  }
  if (!plan.agentReproduction && (!plan.repository?.url || !plan.repository.commitSha)) {
    errors.push("official repository provenance is incomplete");
  }
  return { accepted: errors.length === 0, errors, invalidStepIds: [...invalid] };
}
