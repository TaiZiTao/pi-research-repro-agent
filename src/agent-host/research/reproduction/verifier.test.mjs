import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyReproductionPlan } from "./verifier.ts";

test("verification rejects pending and tampered artifacts but accepts intact completed steps", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-repro-verify-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const artifactsRoot = path.join(root, "artifacts");
  const logPath = path.join(artifactsRoot, "logs", "step-1.log");
  mkdirSync(path.dirname(logPath), { recursive: true });
  const content = "PSNR=30.1\n";
  writeFileSync(logPath, content);

  const step = {
    id: "step-1",
    kind: "evaluate",
    title: "evaluate",
    description: "evaluate",
    command: "node --version",
    status: "succeeded",
    exitCode: 0,
    artifactRef: "logs/step-1.log",
    artifactBytes: Buffer.byteLength(content),
    artifactSha256: createHash("sha256").update(content).digest("hex"),
    error: null,
  };
  const plan = {
    projectId: "123e4567-e89b-42d3-a456-426614174000",
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:00.000Z",
    phase: "running",
    title: "Paper",
    repository: null,
    agentReproduction: true,
    extraction: { repositoryUrl: null, datasets: [], metrics: [], trainingHints: [] },
    steps: [step],
    repairRoundsUsed: 0,
    error: null,
  };

  assert.equal(verifyReproductionPlan(plan, artifactsRoot).accepted, true);
  assert.equal(
    verifyReproductionPlan({ ...plan, steps: [{ ...step, status: "pending" }] }, artifactsRoot).accepted,
    false,
  );
  writeFileSync(logPath, "tampered\n");
  const tampered = verifyReproductionPlan(plan, artifactsRoot);
  assert.equal(tampered.accepted, false);
  assert.deepEqual(tampered.invalidStepIds, ["step-1"]);
});
