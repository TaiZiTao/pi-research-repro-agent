import assert from "node:assert/strict";
import test from "node:test";
import { createReproductionPlan, nextPendingStep, stepById } from "./planner.ts";
import { MAX_REPRODUCTION_TITLE_CHARS, MAX_STEPS } from "./types.ts";

const PROJECT_ID = "123e4567-e89b-42d3-a456-426614174000";
const NO_REPOSITORY_NOTE = "未核验到官方仓库,按 Agent 最小复现执行(不冒充官方)";
const FIXED_NOW = () => new Date("2026-09-03T09:00:00.000Z");

const CANDIDATE = {
  name: "sr-research",
  fullName: "jsmith/sr-research",
  url: "https://github.com/jsmith/sr-research",
  description: null,
  license: "MIT",
  defaultBranch: "main",
  commitSha: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b",
  matchBasis: "title-keywords:super-resolution",
  stars: 42,
};

function chunk(page, text, chunkId = `c${page}`) {
  return { paperId: "0123456789abcdef", chunkId, page, text };
}

function planResult(overrides = {}) {
  return createReproductionPlan({
    projectId: PROJECT_ID,
    title: "Reproduction of the paper",
    chunks: [],
    now: FIXED_NOW,
    ...overrides,
  });
}

test("adopts a verified official repository and starts with a clone step", () => {
  const { plan, notes } = planResult({ repository: CANDIDATE });

  assert.deepEqual(notes, []);
  assert.equal(plan.agentReproduction, false);
  assert.deepEqual(plan.repository, {
    url: "https://github.com/jsmith/sr-research",
    commitSha: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b",
    license: "MIT",
    matchBasis: "title-keywords:super-resolution",
  });
  assert.equal(plan.phase, "planned");
  assert.equal(plan.repairRoundsUsed, 0);
  assert.equal(plan.error, null);
  assert.equal(plan.steps.length, 6);
  assert.deepEqual(plan.steps[0], {
    id: "step-1",
    kind: "repository",
    title: "Clone official repository",
    description: "Fetch the matched official repository into the workspace",
    command: "git clone --depth 1 https://github.com/jsmith/sr-research workspace/",
    status: "pending",
    exitCode: null,
    artifactRef: null,
    error: null,
  });
});

test("falls back to agent reproduction without a verified repository and notes it", () => {
  for (const repository of [
    null,
    undefined,
    { ...CANDIDATE, url: "http://github.com/jsmith/sr-research" },
    { ...CANDIDATE, matchBasis: "   " },
  ]) {
    const { plan, notes } = planResult({ repository });
    assert.equal(plan.repository, null);
    assert.equal(plan.agentReproduction, true);
    assert.deepEqual(notes, [NO_REPOSITORY_NOTE]);
    assert.equal(plan.steps[0].kind, "custom");
    assert.equal(plan.steps[0].title, "Scaffold agent reproduction module");
    assert.equal(plan.steps[0].command, null);
    assert.equal(plan.steps[0].id, "step-1");
  }
});

test("extracts repository url, datasets, metrics and training hints from chunks", () => {
  const text = [
    "We compare on the Set5 dataset and Urban100 benchmark with DIV2K.",
    "PSNR and SSIM improve; FID 5.1 on average.",
    "We used learning rate = 1e-4, Adam, weight decay 0 and batch size 16 for 200 epochs.",
    "Code: https://github.com/jsmith/sr-code",
  ].join("\n");
  const { plan } = planResult({ chunks: [chunk(1, text)] });

  assert.equal(plan.extraction.repositoryUrl, "https://github.com/jsmith/sr-code");
  assert.deepEqual(plan.extraction.datasets, ["Set5", "Urban100", "DIV2K"]);
  assert.deepEqual(plan.extraction.metrics, ["PSNR", "SSIM", "FID"]);
  assert.deepEqual(plan.extraction.trainingHints, [
    "We used learning rate = 1e-4, Adam, weight decay 0 and batch size 16 for 200 epochs.",
  ]);
});

test("extraction never mistakes metric acronyms for datasets", () => {
  const text = "The PSNR benchmark and SSIM dataset were used for FID reporting.";
  const { plan } = planResult({ chunks: [chunk(1, text)] });

  assert.deepEqual(plan.extraction.metrics, ["PSNR", "SSIM", "FID"]);
  assert.deepEqual(plan.extraction.datasets, []);
});

test("empty chunks produce a valid, empty-extraction plan", () => {
  const { plan, notes } = planResult({ title: "   Empty paper   " });

  assert.equal(plan.title, "Empty paper");
  assert.equal(plan.phase, "planned");
  assert.equal(plan.agentReproduction, true);
  assert.deepEqual(plan.extraction, {
    repositoryUrl: null,
    datasets: [],
    metrics: [],
    trainingHints: [],
  });
  assert.equal(plan.steps.length, 6);
  assert.ok(plan.steps.length <= MAX_STEPS);
  assert.deepEqual(notes, [NO_REPOSITORY_NOTE]);
});

test("step ids are stable step-1..step-n and helpers resolve pending steps", () => {
  const { plan } = planResult({ repository: CANDIDATE });

  assert.deepEqual(
    plan.steps.map((step) => step.id),
    ["step-1", "step-2", "step-3", "step-4", "step-5", "step-6"],
  );
  for (const step of plan.steps) {
    assert.equal(step.status, "pending");
    assert.equal(step.exitCode, null);
    assert.equal(step.artifactRef, null);
    assert.equal(step.error, null);
  }
  assert.equal(stepById(plan, "step-3").title, "Acquire dataset/weights");
  assert.equal(stepById(plan, "step-99"), undefined);
  assert.equal(nextPendingStep(plan).id, "step-1");

  const running = {
    ...plan,
    steps: plan.steps.map((step) => (step.id === "step-1" ? { ...step, status: "running" } : step)),
  };
  assert.equal(nextPendingStep(running).id, "step-2");
});

test("over-long titles are truncated to MAX_REPRODUCTION_TITLE_CHARS", () => {
  const longTitle = "x".repeat(320);
  const { plan } = planResult({ title: longTitle });

  assert.equal(plan.title.length, MAX_REPRODUCTION_TITLE_CHARS);
  assert.equal(plan.title, longTitle.slice(0, MAX_REPRODUCTION_TITLE_CHARS));
});

test("planning is deterministic for identical inputs and clock", () => {
  const input = { projectId: PROJECT_ID, title: "Deterministic", chunks: [], repository: CANDIDATE, now: FIXED_NOW };
  const first = createReproductionPlan(input);
  const second = createReproductionPlan(input);

  assert.deepEqual(second.plan, first.plan);
  assert.deepEqual(second.notes, first.notes);
  assert.equal(first.plan.createdAt, "2026-09-03T09:00:00.000Z");
  assert.equal(first.plan.updatedAt, "2026-09-03T09:00:00.000Z");
});
