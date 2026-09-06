import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createReproductionTools } from "./reproduction-tools.ts";
import { reproductionPaths } from "./paths.ts";
import { ReproductionStore } from "./store.ts";

const PROJECT_ID = "123e4567-e89b-42d3-a456-426614174000";
const NOW = "2026-09-03T00:00:00.000Z";
const FIXED_NOW = () => new Date("2026-09-03T09:00:00.000Z");
const CHUNKS = [
  {
    paperId: "0123456789abcdef",
    chunkId: "p1-c1",
    page: 1,
    text: "We report PSNR and SSIM on Set5 and DIV2K. Learning rate 1e-4, batch size 16, 200 epochs.",
  },
];

function step(partial = {}) {
  return {
    id: "step-1",
    kind: "custom",
    title: "step",
    description: "test step",
    command: null,
    status: "pending",
    exitCode: null,
    artifactRef: null,
    artifactBytes: null,
    artifactSha256: null,
    error: null,
    ...partial,
  };
}

function planWith(steps, overrides = {}) {
  return {
    projectId: PROJECT_ID,
    createdAt: NOW,
    updatedAt: NOW,
    phase: "planned",
    title: "Reproduction of the paper",
    repository: null,
    agentReproduction: true,
    extraction: { repositoryUrl: null, datasets: [], metrics: [], trainingHints: [] },
    steps,
    repairRoundsUsed: 0,
    error: null,
    ...overrides,
  };
}

function fixture(t) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "pi-repro-tools-"));
  const workspacePath = path.join(rootDir, "project");
  const store = new ReproductionStore(path.join(rootDir, "research.sqlite"));
  t.after(() => {
    try {
      store.close();
    } catch {
      // already closed
    }
    rmSync(rootDir, { recursive: true, force: true });
  });
  const project = {
    projectId: PROJECT_ID,
    title: "Reproduction of the paper",
    status: "ready",
    workspacePath,
    sourcePdfName: "paper.pdf",
    managedPdfPath: path.join(workspacePath, "input", "paper.pdf"),
    sha256: "a".repeat(64),
    pageCount: 3,
    error: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const reproduction = reproductionPaths(workspacePath);
  return {
    store,
    project,
    cwd: path.join(rootDir, "cwd"),
    workspace: reproduction.workspace,
    artifactsRoot: reproduction.artifactsRoot,
  };
}

function makeTools(t, runner = async () => ({ exitCode: 0, stdout: "ok", stderr: "" }), chunkCalls = []) {
  const { store, project, cwd, workspace, artifactsRoot } = fixture(t);
  const tools = createReproductionTools(cwd, {
    project,
    readChunks: async (projectId) => {
      chunkCalls.push(projectId);
      return CHUNKS;
    },
    store,
    runCommand: runner,
    now: FIXED_NOW,
  });
  return { store, project, cwd, workspace, artifactsRoot, tools };
}

function signal() {
  return new globalThis.AbortController().signal;
}

function payload(result) {
  return JSON.parse(result.content[0].text);
}

test("registers bounded sequential reproduction tools including step configuration", (t) => {
  const { tools } = makeTools(t);
  assert.equal(tools.length, 5);
  const [planTool, executeTool, verifyTool, reportTool, configureTool] = tools;

  for (const tool of tools) {
    assert.equal(tool.executionMode, "sequential");
    assert.equal(tool.parameters.additionalProperties, false);
  }
  assert.equal(planTool.name, "research_plan_reproduction");
  assert.deepEqual(Object.keys(planTool.parameters.properties), [
    "repositoryUrl",
    "commitSha",
    "license",
    "matchBasis",
  ]);
  assert.equal(planTool.parameters.properties.repositoryUrl.maxLength, 300);
  assert.equal(planTool.parameters.properties.commitSha.maxLength, 64);
  assert.equal(planTool.parameters.properties.license.maxLength, 64);
  assert.equal(planTool.parameters.properties.matchBasis.maxLength, 200);

  assert.equal(executeTool.name, "research_reproduction_execute");
  assert.deepEqual(Object.keys(executeTool.parameters.properties), ["action"]);

  assert.equal(verifyTool.name, "research_reproduction_verify");
  assert.deepEqual(Object.keys(verifyTool.parameters.properties), ["reason", "repair"]);
  assert.equal(verifyTool.parameters.properties.reason.maxLength, 500);

  assert.equal(reportTool.name, "research_reproduction_report");
  assert.deepEqual(Object.keys(reportTool.parameters.properties), []);
  assert.equal(configureTool.name, "research_reproduction_configure_step");
  assert.deepEqual(Object.keys(configureTool.parameters.properties), ["stepId", "command"]);
  assert.equal(
    tools.some((tool) => tool.name.includes("download")),
    false,
  );
});

test("plans an agent reproduction without a repository and persists it", async (t) => {
  const { store, tools } = makeTools(t);
  const [planTool] = tools;

  const result = await planTool.execute("call-1", {}, signal());
  const output = payload(result);
  assert.equal(output.planId, PROJECT_ID);
  assert.equal(output.status, "planned");
  assert.equal(output.stepCount, 6);
  assert.equal(output.agentReproduction, true);
  assert.equal(output.repository, null);
  assert.ok(output.notes.some((note) => note.includes("不冒充官方")));
  assert.deepEqual(result.details, output);

  const stored = store.get(PROJECT_ID);
  assert.ok(stored);
  assert.equal(stored.agentReproduction, true);
  assert.equal(stored.steps[0].command, null);
  assert.equal(stored.steps[0].id, "step-1");
  assert.equal(stored.steps.length, 6);
});

test("adopts a verified official https repository into the plan", async (t) => {
  const { store, tools } = makeTools(t);
  const [planTool] = tools;

  const result = await planTool.execute(
    "call-1",
    {
      repositoryUrl: "https://github.com/jsmith/sr-research",
      commitSha: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b",
      license: "MIT",
      matchBasis: "title-keywords:super-resolution",
    },
    signal(),
  );
  const output = payload(result);
  assert.equal(output.agentReproduction, false);
  assert.deepEqual(output.repository, {
    url: "https://github.com/jsmith/sr-research",
    commitSha: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b",
    license: "MIT",
    matchBasis: "title-keywords:super-resolution",
  });
  assert.deepEqual(output.notes, []);

  const stored = store.get(PROJECT_ID);
  assert.equal(stored.repository.url, "https://github.com/jsmith/sr-research");
  assert.match(stored.steps[0].command, /^git clone/);
});

test("rejects a non-https repositoryUrl with a bounded InvalidParams error", async (t) => {
  const { store, tools } = makeTools(t);
  const [planTool] = tools;

  const result = await planTool.execute("call-1", { repositoryUrl: "http://github.com/jsmith/sr-research" }, signal());
  const output = payload(result);
  assert.equal(typeof output.error, "string");
  assert.ok(output.error.includes("InvalidParams"));
  assert.ok(output.error.length <= 500);
  assert.deepEqual(result.details, { error: output.error });
  assert.equal(store.get(PROJECT_ID), undefined);
});

test("begin-run and next-step run command steps and leave agent steps pending", async (t) => {
  const calls = [];
  const runner = async (command, options) => {
    calls.push({ command, cwd: options.cwd, timeoutMs: options.timeoutMs });
    return { exitCode: 0, stdout: "ok", stderr: "" };
  };
  const { store, workspace, tools } = makeTools(t, runner);
  const [, executeTool, , , configureTool] = tools;
  store.put(
    planWith([
      step({ id: "step-1", title: "train", command: "python train.py" }),
      step({ id: "step-2", title: "agent step" }),
    ]),
  );

  const begun = payload(await executeTool.execute("call-1", { action: "begin-run" }, signal()));
  assert.equal(begun.phase, "running");
  assert.equal(begun.action, "ran");
  assert.equal(store.get(PROJECT_ID).phase, "running");

  const ran = payload(await executeTool.execute("call-2", { action: "next-step" }, signal()));
  assert.equal(ran.phase, "running");
  assert.equal(ran.action, "ran");
  assert.deepEqual(ran.step, {
    id: "step-1",
    title: "train",
    status: "succeeded",
    exitCode: 0,
    artifactRef: "logs/step-1.log",
    error: null,
    command: "python train.py",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "python train.py");
  assert.equal(calls[0].cwd, workspace);
  assert.equal(calls[0].timeoutMs, 120000);
  assert.equal(store.get(PROJECT_ID).steps[0].status, "succeeded");

  const needsAgent = payload(await executeTool.execute("call-3", { action: "next-step" }, signal()));
  assert.equal(needsAgent.action, "needs-agent");
  assert.equal(needsAgent.step.id, "step-2");
  assert.equal(needsAgent.step.status, "pending");
  assert.equal(store.get(PROJECT_ID).steps[1].status, "pending");
  assert.equal(calls.length, 1, "commandless steps never call the runner");

  const incomplete = payload(await tools[2].execute("call-incomplete", {}, signal()));
  assert.equal(incomplete.accepted, false);
  assert.equal(incomplete.phase, "running");

  const configured = payload(
    await configureTool.execute("call-4", { stepId: "step-2", command: "node --version" }, signal()),
  );
  assert.equal(configured.step.command, "node --version");
  const secondRun = payload(await executeTool.execute("call-5", { action: "next-step" }, signal()));
  assert.equal(secondRun.step.id, "step-2");
  assert.equal(secondRun.step.status, "succeeded");
});

test("verify accepts a fully succeeded run and completes it", async (t) => {
  const { store, tools } = makeTools(t);
  const [, executeTool, verifyTool] = tools;
  store.put(planWith([step({ id: "step-1", title: "train", command: "python train.py" })]));

  await executeTool.execute("call-1", { action: "begin-run" }, signal());
  const ran = payload(await executeTool.execute("call-2", { action: "next-step" }, signal()));
  assert.equal(ran.step.status, "succeeded");
  const done = payload(await executeTool.execute("call-3", { action: "next-step" }, signal()));
  assert.equal(done.action, "done");

  const verified = payload(await verifyTool.execute("call-4", {}, signal()));
  assert.equal(verified.accepted, true);
  assert.equal(verified.phase, "completed");
  assert.equal(verified.repairRoundsUsed, 0);
  assert.equal(verified.error, null);
  assert.equal(store.get(PROJECT_ID).phase, "completed");
});

test("verify with repair resets failed steps, increments rounds, then blocks", async (t) => {
  const { store, tools } = makeTools(t, async () => ({ exitCode: 1, stdout: "", stderr: "boom" }));
  const [, executeTool, verifyTool] = tools;
  store.put(planWith([step({ id: "step-1", title: "train", command: "python train.py" })]));
  await executeTool.execute("call-0", { action: "begin-run" }, signal());

  for (const expectedRound of [1, 2, 3]) {
    const ran = payload(await executeTool.execute("call-run", { action: "next-step" }, signal()));
    assert.equal(ran.action, "ran");
    assert.equal(ran.step.status, "failed");
    assert.equal(ran.step.exitCode, 1);
    assert.match(ran.step.error, /failed with exit code 1/);

    const verified = payload(
      await verifyTool.execute("call-verify", { reason: "metrics mismatch", repair: true }, signal()),
    );
    assert.equal(verified.phase, "running");
    assert.equal(verified.repairRoundsUsed, expectedRound);
    assert.match(verified.error, new RegExp("repair round " + expectedRound));
    const stored = store.get(PROJECT_ID);
    assert.equal(stored.repairRoundsUsed, expectedRound);
    assert.equal(stored.steps[0].status, "pending", "repair resets failed steps");
  }

  const failed = payload(await executeTool.execute("call-last", { action: "next-step" }, signal()));
  assert.equal(failed.step.status, "failed");
  const blocked = payload(await verifyTool.execute("call-block", { reason: "still failing", repair: true }, signal()));
  assert.equal(blocked.phase, "blocked");
  assert.equal(blocked.repairRoundsUsed, 3);
  assert.ok(blocked.error.length > 0 && blocked.error.length <= 500);
  assert.equal(store.get(PROJECT_ID).phase, "blocked");
});

test("report renders bounded markdown that marks Agent 最小复现 and lists artifacts", async (t) => {
  const { store, tools } = makeTools(t);
  const [, executeTool, verifyTool, reportTool] = tools;
  store.put(planWith([step({ id: "step-1", title: "train", command: "python train.py" })]));
  await executeTool.execute("call-1", { action: "begin-run" }, signal());
  await executeTool.execute("call-2", { action: "next-step" }, signal());
  await verifyTool.execute("call-3", {}, signal());

  const result = await reportTool.execute("call-4", {}, signal());
  const output = payload(result);
  assert.equal(typeof output.markdown, "string");
  assert.ok(output.markdown.includes("(Agent 最小复现)"));
  assert.ok(output.markdown.includes("- 无官方仓库"));
  assert.ok(output.markdown.includes("## 步骤"));
  assert.ok(output.markdown.includes("## 产物"));
  assert.ok(output.markdown.includes("logs/step-1.log"));
  assert.ok(output.markdown.includes("| step-1 |"));
  assert.ok(output.markdown.length <= 20000);
});

test("runner failures become bounded tool errors with local paths redacted", async (t) => {
  const { store, cwd, workspace, tools } = makeTools(t, async () => {
    throw new Error(`spawn failed near ${workspace} (cwd ${cwd})`);
  });
  const [, executeTool] = tools;
  store.put(planWith([step({ id: "step-1", title: "train", command: "python train.py" })], { phase: "running" }));

  const result = await executeTool.execute("call-1", { action: "next-step" }, signal());
  const output = payload(result);
  assert.equal(typeof output.error, "string");
  assert.ok(output.error.length <= 500);
  assert.ok(!output.error.includes(workspace), "reproduction workspace must not leak");
  assert.ok(!output.error.includes(cwd), "cwd must not leak");
  assert.ok(output.error.includes("[redacted]"));
  assert.deepEqual(result.details, { error: output.error });
});

test("execute, verify and report fail with bounded errors when no plan exists", async (t) => {
  const { tools } = makeTools(t);
  const [, executeTool, verifyTool, reportTool] = tools;

  for (const result of [
    await executeTool.execute("call-1", { action: "begin-run" }, signal()),
    await executeTool.execute("call-2", { action: "next-step" }, signal()),
    await verifyTool.execute("call-3", {}, signal()),
    await reportTool.execute("call-4", {}, signal()),
  ]) {
    const output = payload(result);
    assert.equal(typeof output.error, "string");
    assert.ok(output.error.includes("no reproduction plan"));
    assert.ok(output.error.length <= 500);
    assert.deepEqual(result.details, { error: output.error });
  }
});
