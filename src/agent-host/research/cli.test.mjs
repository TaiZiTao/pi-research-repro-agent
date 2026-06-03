import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { executeResearchCli } from "./cli.ts";

function harness(projects = []) {
  const calls = [];
  const output = [];
  const errors = [];
  let closed = false;
  const service = {
    async importPdf(input) {
      calls.push(["import", input]);
      return projects[0];
    },
    listProjects() {
      calls.push(["list"]);
      return projects;
    },
    searchEvidence(projectId, query, limit) {
      calls.push(["search", projectId, query, limit]);
      return [{ paperId: "a".repeat(64), chunkId: "p2-c1", page: 2, text: "evidence", score: 2 }];
    },
  };
  return {
    calls,
    output,
    errors,
    get closed() {
      return closed;
    },
    options: {
      appRoot: path.resolve("test-app"),
      env: {},
      stdout: (line) => output.push(JSON.parse(line)),
      stderr: (line) => errors.push(JSON.parse(line)),
      createRuntime: () => ({ service, close: () => (closed = true) }),
    },
  };
}

const readyProject = {
  projectId: "123e4567-e89b-42d3-a456-426614174000",
  title: "A paper",
  status: "ready",
  workspacePath: path.resolve("workspace"),
};

test("import requires explicit user data and reports a bounded JSON error", async () => {
  const run = harness([readyProject]);
  const exitCode = await executeResearchCli(["import", "--pdf", path.resolve("paper.pdf")], run.options);

  assert.equal(exitCode, 1);
  assert.equal(run.closed, false);
  assert.match(run.errors[0].error, /--user-data|PI_DESKTOP_USER_DATA/);
});

test("imports a PDF and closes the runtime", async () => {
  const run = harness([readyProject]);
  const pdf = path.resolve("paper.pdf");
  const exitCode = await executeResearchCli(
    ["import", "--pdf", pdf, "--title", "A paper", "--user-data", path.resolve("user-data")],
    run.options,
  );

  assert.equal(exitCode, 0);
  assert.deepEqual(run.calls, [["import", { sourcePath: pdf, title: "A paper" }]]);
  assert.equal(run.output[0].command, "import");
  assert.deepEqual(run.output[0].project, readyProject);
  assert.equal(run.closed, true);
});

test("lists projects from the selected user data directory", async () => {
  const run = harness([readyProject]);
  const exitCode = await executeResearchCli(["list", "--user-data", path.resolve("user-data")], run.options);

  assert.equal(exitCode, 0);
  assert.deepEqual(run.calls, [["list"]]);
  assert.deepEqual(run.output[0].projects, [readyProject]);
  assert.equal(run.closed, true);
});

test("search validates its bound and returns evidence JSON", async () => {
  const run = harness([readyProject]);
  const userData = path.resolve("user-data");
  const invalid = await executeResearchCli(
    ["search", "--project", readyProject.projectId, "--query", "frequency", "--limit", "9", "--user-data", userData],
    run.options,
  );
  assert.equal(invalid, 1);
  assert.equal(run.calls.length, 0);

  const valid = await executeResearchCli(
    ["search", "--project", readyProject.projectId, "--query", "frequency", "--limit", "3", "--user-data", userData],
    run.options,
  );
  assert.equal(valid, 0);
  assert.deepEqual(run.calls, [["search", readyProject.projectId, "frequency", 3]]);
  assert.equal(run.output[0].hits[0].page, 2);
  assert.equal(run.closed, true);
});
