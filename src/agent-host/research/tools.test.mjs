import assert from "node:assert/strict";
import test from "node:test";
import { createResearchTools } from "./tools.ts";

const project = {
  projectId: "123e4567-e89b-42d3-a456-426614174000",
  title: "Evidence paper",
  status: "ready",
  workspacePath: "/research/project",
  sourcePdfName: "paper.pdf",
  managedPdfPath: "/research/project/input/paper.pdf",
  sha256: "a".repeat(64),
  pageCount: 3,
  error: null,
  createdAt: "2026-09-03T00:00:00.000Z",
  updatedAt: "2026-09-03T00:00:00.000Z",
};

test("returns no research tools outside a ready project", () => {
  assert.deepEqual(createResearchTools("/elsewhere", { findByWorkspace: () => undefined }), []);
  assert.deepEqual(
    createResearchTools("/research/project", { findByWorkspace: () => ({ ...project, status: "failed" }) }),
    [],
  );
});

test("defines bounded evidence search and answer verification tools for a ready project", () => {
  const [tool, verifier] = createResearchTools("/research/project", {
    findByWorkspace: () => project,
    searchEvidence: () => [],
    verifyAnswer: () => ({ accepted: true, errors: [] }),
  });

  assert.equal(tool.name, "research_search_evidence");
  assert.equal(tool.label, "search paper evidence");
  assert.equal(tool.executionMode, "sequential");
  assert.match(tool.description, /current project/i);
  assert.match(tool.description, /page/i);
  assert.deepEqual(Object.keys(tool.parameters.properties), ["query", "limit"]);
  assert.equal(tool.parameters.properties.query.minLength, 1);
  assert.equal(tool.parameters.properties.query.maxLength, 1000);
  assert.equal(tool.parameters.properties.limit.minimum, 1);
  assert.equal(tool.parameters.properties.limit.maximum, 8);
  assert.equal(tool.parameters.additionalProperties, false);
  assert.equal(verifier.name, "research_finalize_answer");
  assert.equal(verifier.executionMode, "sequential");
  assert.deepEqual(Object.keys(verifier.parameters.properties), ["status", "answer", "citations"]);
});

test("executes evidence search against only the workspace-bound project", async () => {
  const hits = [{ paperId: project.sha256, chunkId: "p2-c3", page: 2, text: "direct evidence", score: 4 }];
  const calls = [];
  const [tool, verifier] = createResearchTools(project.workspacePath, {
    findByWorkspace: (cwd) => (cwd === project.workspacePath ? project : undefined),
    searchEvidence: async (...args) => {
      calls.push(args);
      return hits;
    },
    verifyAnswer: (projectId, draft) => {
      calls.push([projectId, draft]);
      return { accepted: true, errors: [] };
    },
  });

  const result = await tool.execute("call-1", { query: "evidence", limit: 3 }, new globalThis.AbortController().signal);

  assert.deepEqual(calls, [[project.projectId, "evidence", 3]]);
  assert.deepEqual(JSON.parse(result.content[0].text), { projectId: project.projectId, hits });
  assert.deepEqual(result.details, { hits });

  const draft = {
    status: "grounded",
    answer: "Evidence-backed answer",
    citations: [{ paperId: project.sha256, page: 2, chunkId: "p2-c3", quote: "direct evidence" }],
  };
  const verified = await verifier.execute("call-2", draft, new globalThis.AbortController().signal);
  assert.deepEqual(calls[1], [project.projectId, draft]);
  assert.equal(JSON.parse(verified.content[0].text).accepted, true);
});
