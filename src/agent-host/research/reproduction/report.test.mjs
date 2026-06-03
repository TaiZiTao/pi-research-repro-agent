import assert from "node:assert/strict";
import test from "node:test";
import { buildReproductionReport, renderReproductionMarkdown } from "./report.ts";

const FIXED_NOW = () => new Date("2026-09-03T12:00:00.000Z");

function step(overrides = {}) {
  return {
    id: "step-1",
    kind: "train",
    title: "Run training/finetune",
    description: "desc",
    command: null,
    status: "succeeded",
    exitCode: 0,
    artifactRef: null,
    error: null,
    ...overrides,
  };
}

function plan(overrides = {}) {
  return {
    projectId: "123e4567-e89b-42d3-a456-426614174000",
    createdAt: "2026-09-03T09:00:00.000Z",
    updatedAt: "2026-09-03T09:00:00.000Z",
    phase: "completed",
    title: "Reproduction of SRGAN",
    repository: null,
    agentReproduction: true,
    extraction: { repositoryUrl: null, datasets: [], metrics: [], trainingHints: [] },
    steps: [
      step({ id: "step-1", kind: "repository", title: "Clone official repository", artifactRef: "repo/src" }),
      step({
        id: "step-2",
        kind: "evaluate",
        title: "Run evaluation and record metrics",
        artifactRef: "metrics.json",
        exitCode: 0,
      }),
    ],
    repairRoundsUsed: 1,
    error: null,
    ...overrides,
  };
}

test("a completed plan produces a report with steps, artifacts and metadata", () => {
  const report = buildReproductionReport(plan(), ["artifacts/metrics.json", "artifacts/checkpoint.pt"], FIXED_NOW);

  assert.equal(report.projectId, "123e4567-e89b-42d3-a456-426614174000");
  assert.equal(report.phase, "completed");
  assert.equal(report.title, "Reproduction of SRGAN");
  assert.equal(report.agentReproduction, true);
  assert.equal(report.repairRoundsUsed, 1);
  assert.equal(report.generatedAt, "2026-09-03T12:00:00.000Z");
  assert.equal(report.stepSummary.length, 2);
  assert.equal(report.stepSummary[0].id, "step-1");
  assert.equal(report.stepSummary[0].artifactRef, "repo/src");
  assert.equal(report.stepSummary[0].description, undefined);
  assert.deepEqual(report.artifacts, ["artifacts/metrics.json", "artifacts/checkpoint.pt"]);

  const markdown = renderReproductionMarkdown(report);
  assert.ok(markdown.includes("# Reproduction of SRGAN"));
  assert.ok(markdown.includes("## 来源"));
  assert.ok(markdown.includes("## 步骤"));
  assert.ok(markdown.includes("## 产物"));
  assert.ok(markdown.includes("Clone official repository"));
  assert.ok(markdown.includes("artifacts/metrics.json"));
  assert.ok(markdown.includes("修复轮次: 1"));
  assert.ok(markdown.length < 2000);
});

test("agent reproduction headings and official repository sources render distinctly", () => {
  const agentMarkdown = renderReproductionMarkdown(buildReproductionReport(plan(), [], FIXED_NOW));
  assert.ok(agentMarkdown.includes("# Reproduction of SRGAN (Agent 最小复现)"));
  assert.ok(agentMarkdown.includes("- 无官方仓库"));

  const official = plan({
    agentReproduction: false,
    repository: {
      url: "https://github.com/jsmith/sr-research",
      commitSha: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b",
      license: "MIT",
      matchBasis: "title-keywords:super-resolution",
    },
  });
  const officialMarkdown = renderReproductionMarkdown(buildReproductionReport(official, [], FIXED_NOW));
  assert.ok(!officialMarkdown.includes("Agent 最小复现"));
  assert.ok(!officialMarkdown.includes("无官方仓库"));
  assert.ok(officialMarkdown.includes("- 仓库: https://github.com/jsmith/sr-research"));
  assert.ok(officialMarkdown.includes("9f86d081884c7d659a2feaa0c55ad015a3bf4f1b"));
  assert.ok(officialMarkdown.includes("MIT"));
  assert.ok(officialMarkdown.includes("title-keywords:super-resolution"));
});

test("table cells escape pipes and collapse newlines", () => {
  const tricky = plan({
    steps: [
      step({ id: "step-1", title: "A | B", status: "failed", exitCode: 1, error: "failed step\nreason | code 7" }),
    ],
  });
  const markdown = renderReproductionMarkdown(buildReproductionReport(tricky, [], FIXED_NOW));

  assert.ok(markdown.includes("A \\| B"));
  assert.ok(markdown.includes("failed step reason \\| code 7"));
  assert.ok(!markdown.includes("failed step\nreason"));
});

test("missing artifact names produce an empty artifact list", () => {
  const report = buildReproductionReport(plan(), [], FIXED_NOW);
  assert.deepEqual(report.artifacts, []);
  const markdown = renderReproductionMarkdown(report);
  assert.ok(markdown.includes("## 产物"));
  assert.ok(markdown.includes("- 无"));
});

test("rendered markdown stays bounded even for pathological inputs", () => {
  const bigSteps = Array.from({ length: 20 }, (_, index) =>
    step({
      id: `step-${index + 1}`,
      title: "t".repeat(300),
      error: "e".repeat(499),
      status: "failed",
      exitCode: index + 1,
    }),
  );
  const bigArtifacts = Array.from({ length: 200 }, (_, index) => `artifacts/${"a".repeat(350)}-${index}`);
  const big = plan({ phase: "blocked", steps: bigSteps });
  const markdown = renderReproductionMarkdown(buildReproductionReport(big, bigArtifacts, FIXED_NOW));
  assert.ok(markdown.length <= 20000);
  assert.ok(markdown.length > 1000);
});

test("the report copies artifact names and never aliases the input array", () => {
  const artifacts = ["a.json", "b.pt"];
  const report = buildReproductionReport(plan(), artifacts, FIXED_NOW);
  artifacts.push("c.log");
  assert.deepEqual(report.artifacts, ["a.json", "b.pt"]);
});
