import assert from "node:assert/strict";
import test from "node:test";
import { runHybridWorker } from "./hybrid-worker.ts";

test("hybrid worker sends one bounded JSON request and parses structured output", async () => {
  const calls = [];
  const run = async (...args) => {
    calls.push(args);
    return { stdout: JSON.stringify({ ok: true, action: "search", hits: [] }) };
  };
  const result = await runHybridWorker(
    "python",
    "worker.py",
    { action: "search", indexDir: "evidence", paperId: "a".repeat(64), query: "loss", k: 3 },
    run,
  );
  assert.equal(result.ok, true);
  assert.deepEqual(calls[0][0], "python");
  assert.deepEqual(calls[0][1], [
    "worker.py",
    JSON.stringify({ action: "search", indexDir: "evidence", paperId: "a".repeat(64), query: "loss", k: 3 }),
  ]);
  assert.equal(calls[0][2].windowsHide, true);
  await assert.rejects(
    runHybridWorker(
      "python",
      "worker.py",
      { action: "build", indexDir: "evidence", chunksPath: "chunks.json", paperId: "a".repeat(64) },
      async () => ({ stdout: "not-json" }),
    ),
    /invalid JSON/i,
  );
});
