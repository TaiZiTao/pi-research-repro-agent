import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  clearResearchEventLog,
  listResearchEvents,
  recordReproductionPlanPut,
  recordResearchEvent,
} from "./event-log.ts";
import { ReproductionStore } from "./reproduction/store.ts";

test.afterEach(() => clearResearchEventLog());

test("record and list events newest first with a read limit", () => {
  recordResearchEvent("p-1", {
    type: "ingestion",
    stage: "copying",
    message: "a",
    createdAt: "2026-01-01T00:00:01.000Z",
  });
  recordResearchEvent("p-1", {
    type: "ingestion",
    stage: "complete",
    message: "b",
    createdAt: "2026-01-01T00:00:02.000Z",
  });
  recordResearchEvent("p-2", {
    type: "ingestion",
    stage: "parsing",
    message: "other",
    createdAt: "2026-01-01T00:00:03.000Z",
  });

  const all = listResearchEvents("p-1");
  assert.equal(all.length, 2);
  assert.equal(all[0].message, "b");
  assert.equal(all[1].message, "a");
  assert.equal(listResearchEvents("p-1", 1).length, 1);
  assert.equal(listResearchEvents("missing").length, 0);
  assert.deepEqual(
    listResearchEvents("p-2").map((e) => e.stage),
    ["parsing"],
  );
});

test("ledger is capped per project", () => {
  for (let i = 0; i < 250; i += 1) {
    recordResearchEvent("p-1", { type: "ingestion", message: `m${i}`, createdAt: String(i) });
  }
  const all = listResearchEvents("p-1", 1000);
  assert.equal(all.length, 200);
  assert.equal(all[0].message, "m249");
  assert.equal(all[199].message, "m50");
});

test("clear removes every project ledger", () => {
  recordResearchEvent("p-1", { type: "ingestion", message: "x", createdAt: "t" });
  clearResearchEventLog();
  assert.equal(listResearchEvents("p-1").length, 0);
});

function plan(overrides = {}) {
  const base = {
    projectId: "11111111-1111-4111-8111-111111111111",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    phase: "planned",
    title: "复现 Qwen LoRA 实验",
    repository: null,
    agentReproduction: true,
    extraction: { repositoryUrl: null, datasets: [], metrics: [], trainingHints: [] },
    steps: [
      {
        id: "step-1",
        kind: "train",
        title: "训练 LoRA",
        description: "",
        command: null,
        status: "pending",
        exitCode: null,
        artifactRef: null,
        artifactBytes: null,
        artifactSha256: null,
        error: null,
      },
    ],
    repairRoundsUsed: 0,
    error: null,
  };
  return { ...base, ...overrides };
}

test("reproduction recorder emits creation, phase, step and summary events", () => {
  const projectId = "11111111-1111-4111-8111-111111111111";
  recordReproductionPlanPut(projectId, undefined, plan(), "t1");
  let events = listResearchEvents(projectId);
  assert.equal(events.length, 1);
  assert.match(events[0].message, /已创建复现计划/);
  assert.equal(events[0].stage, "planned");

  const created = plan();
  const running = plan({ phase: "running", updatedAt: "t2", steps: [{ ...created.steps[0], status: "running" }] });
  recordReproductionPlanPut(projectId, created, running, "t2");
  events = listResearchEvents(projectId);
  assert.equal(events.length, 3);
  assert.deepEqual(
    events.map((e) => e.message),
    ["step-1 训练 LoRA → 执行中", "复现阶段 → 执行中", "已创建复现计划:复现 Qwen LoRA 实验"],
  );

  const succeeded = plan({
    phase: "completed",
    repairRoundsUsed: 1,
    updatedAt: "t3",
    steps: [{ ...created.steps[0], status: "succeeded" }],
  });
  recordReproductionPlanPut(projectId, running, succeeded, "t3");
  events = listResearchEvents(projectId);
  assert.deepEqual(
    events.slice(0, 3).map((e) => e.message),
    ["复现完成 · 修复轮次 1", "step-1 训练 LoRA → 成功", "复现阶段 → 完成"],
  );
});

test("reproduction recorder ignores no-op puts and caps error text", () => {
  const projectId = "11111111-1111-4111-8111-111111111111";
  const created = plan();
  const current = plan({
    phase: "blocked",
    repairRoundsUsed: 2,
    error: "e".repeat(500),
    updatedAt: "t1",
    steps: [{ ...created.steps[0], status: "failed" }],
  });
  recordReproductionPlanPut(projectId, undefined, current, "t1");
  const before = listResearchEvents(projectId).length;
  recordReproductionPlanPut(projectId, current, current, "t2");
  assert.equal(listResearchEvents(projectId).length, before);

  const previous = plan({ phase: "running", updatedAt: "t0", steps: [{ ...created.steps[0], status: "failed" }] });
  recordReproductionPlanPut(projectId, previous, current, "t3");
  const events = listResearchEvents(projectId);
  assert.ok(events[0].message.startsWith("复现阻塞 · 修复轮次 2:"));
  assert.ok(events[0].message.length < 200);
});

test("ReproductionStore onPut observes every put with previous plan", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-repro-store-events-"));
  const seen = [];
  const store = new ReproductionStore(path.join(dir, "research.sqlite"), {
    onPut: (previous, next) => seen.push({ previous, next }),
  });
  try {
    const created = plan();
    store.put(created);
    const running = plan({ phase: "running", updatedAt: "t2", steps: [{ ...created.steps[0], status: "running" }] });
    store.put(running);
    assert.equal(seen.length, 2);
    assert.equal(seen[0].previous, undefined);
    assert.equal(seen[0].next.projectId, created.projectId);
    assert.equal(seen[1].previous.phase, "planned");
    assert.equal(seen[1].next.phase, "running");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
