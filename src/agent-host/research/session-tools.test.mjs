import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createResearchSessionTools } from "./session-tools.ts";

const PROJECT_ID = "123e4567-e89b-42d3-a456-426614174000";

function project(workspacePath) {
  return {
    projectId: PROJECT_ID,
    title: "Paper",
    status: "ready",
    workspacePath,
    sourcePdfName: "paper.pdf",
    managedPdfPath: path.join(workspacePath, "input", "paper.pdf"),
    sha256: "a".repeat(64),
    pageCount: 1,
    error: null,
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:00.000Z",
  };
}

function service(boundProject) {
  return {
    findByWorkspace: () => boundProject,
    searchEvidence: async () => [],
    verifyAnswer: () => ({ accepted: true, errors: [] }),
    readChunks: async () => [],
  };
}

const client = {
  searchPapers: async () => [],
  downloadPaper: async () => ({ path: "paper.pdf", sha256: "b".repeat(64), bytes: 1 }),
  searchRepositories: async () => [],
  close: async () => {},
};

function names(tools) {
  return tools.map((tool) => tool.name);
}

test("session tools expose acquisition globally and reproduction only for a ready project", () => {
  const cwd = path.resolve("session-tools-workspace");
  const common = {
    acquisition: { client, downloadsRoot: path.resolve("downloads") },
    reproduction: {
      store: { get: () => undefined, put: () => {} },
      runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    },
  };

  const globalNames = names(createResearchSessionTools(cwd, { ...common, projectService: service(undefined) }));
  assert.deepEqual(globalNames, ["research_search_papers", "research_download_paper", "research_search_repositories"]);

  const readyNames = names(createResearchSessionTools(cwd, { ...common, projectService: service(project(cwd)) }));
  assert.ok(readyNames.includes("research_search_evidence"));
  assert.ok(readyNames.includes("research_finalize_answer"));
  assert.ok(readyNames.includes("research_plan_reproduction"));
  assert.ok(readyNames.includes("research_reproduction_execute"));
});
