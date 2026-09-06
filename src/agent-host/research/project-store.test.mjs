import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ResearchProjectStore } from "./project-store.ts";

function createStore(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-research-store-"));
  const store = new ResearchProjectStore(path.join(directory, "nested", "research.sqlite"));
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return store;
}

function project(overrides = {}) {
  return {
    projectId: "123e4567-e89b-42d3-a456-426614174000",
    title: "Initial title",
    status: "created",
    workspacePath: "/workspace/project",
    sourcePdfName: "paper.pdf",
    managedPdfPath: "/workspace/project/input/paper.pdf",
    sha256: "abc123",
    pageCount: null,
    error: null,
    createdAt: "2026-09-03T09:00:00.000Z",
    updatedAt: "2026-09-03T09:00:00.000Z",
    ...overrides,
  };
}

test("SQLite round-trips a research project", (t) => {
  const store = createStore(t);
  const expected = project();

  store.put(expected);

  assert.deepEqual(store.get(expected.projectId), expected);
  assert.equal(store.get("123e4567-e89b-42d3-b456-426614174000"), undefined);
});

test("SQLite upsert updates a project and lists newest first", (t) => {
  const store = createStore(t);
  const first = project();
  const second = project({
    projectId: "223e4567-e89b-42d3-a456-426614174000",
    title: "Second project",
    updatedAt: "2026-09-03T10:00:00.000Z",
  });
  const updatedFirst = project({
    title: "Updated title",
    status: "ready",
    pageCount: 12,
    updatedAt: "2026-09-03T11:00:00.000Z",
  });

  store.put(first);
  store.put(second);
  store.put(updatedFirst);

  assert.deepEqual(store.get(first.projectId), updatedFirst);
  assert.deepEqual(store.list(), [updatedFirst, second]);
});
