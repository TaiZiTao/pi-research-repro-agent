import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ReproductionStore } from "./store.ts";

function createStore(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-reproduction-store-"));
  const store = new ReproductionStore(path.join(directory, "nested", "research.sqlite"));
  t.after(() => {
    try {
      store.close();
    } catch {
      // Already closed by the test itself.
    }
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, directory };
}

function plan(overrides = {}) {
  return {
    projectId: "123e4567-e89b-42d3-a456-426614174000",
    createdAt: "2026-09-03T09:00:00.000Z",
    updatedAt: "2026-09-03T09:00:00.000Z",
    phase: "planned",
    title: "Reproduction plan",
    repository: null,
    agentReproduction: true,
    extraction: { repositoryUrl: null, datasets: [], metrics: [], trainingHints: [] },
    steps: [],
    repairRoundsUsed: 0,
    error: null,
    ...overrides,
  };
}

test("SQLite round-trips a reproduction plan", (t) => {
  const { store } = createStore(t);
  const expected = plan();

  store.put(expected);

  assert.deepEqual(store.get(expected.projectId), expected);
  assert.equal(store.get("223e4567-e89b-42d3-a456-426614174000"), undefined);
});

test("SQLite upsert updates a plan and lists newest first", (t) => {
  const { store } = createStore(t);
  const first = plan();
  const second = plan({
    projectId: "223e4567-e89b-42d3-a456-426614174000",
    title: "Second reproduction plan",
    updatedAt: "2026-09-03T10:00:00.000Z",
  });
  const updatedFirst = plan({
    title: "Updated reproduction plan",
    phase: "preparing",
    updatedAt: "2026-09-03T11:00:00.000Z",
  });

  store.put(first);
  store.put(second);
  store.put(updatedFirst);

  assert.deepEqual(store.get(first.projectId), updatedFirst);
  assert.deepEqual(store.list(), [updatedFirst, second]);
});

test("put rejects project ids that are not RFC-4122 version-4 UUIDs", (t) => {
  const { store } = createStore(t);
  for (const projectId of [
    "not-a-uuid",
    "123e4567-e89b-12d3-a456-426614174000",
    "123e4567e89b42d3a456426614174000",
    "../123e4567-e89b-42d3-a456-426614174000",
  ]) {
    assert.throws(() => store.put(plan({ projectId })), /UUID/, projectId);
  }
});

test("a second connection sees rows written by the first (WAL same file)", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-reproduction-shared-"));
  const databasePath = path.join(directory, "research.sqlite");
  const firstStore = new ReproductionStore(databasePath);
  const expected = plan();
  firstStore.put(expected);
  const secondStore = new ReproductionStore(databasePath);
  t.after(() => {
    firstStore.close();
    secondStore.close();
    rmSync(directory, { recursive: true, force: true });
  });

  assert.deepEqual(secondStore.get(expected.projectId), expected);
  assert.deepEqual(secondStore.list(), [expected]);
});

test("close() releases the connection and later access throws", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-reproduction-close-"));
  const store = new ReproductionStore(path.join(directory, "research.sqlite"));
  const expected = plan();
  store.put(expected);
  store.close();
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  assert.throws(() => store.list(), /not open|closed|state/i);
  assert.throws(() => store.put(plan()), /not open|closed|state/i);
});
