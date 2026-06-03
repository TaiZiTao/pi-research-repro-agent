import assert from "node:assert/strict";
import test from "node:test";
import { runPaperParser } from "./python-worker.ts";

test("paper parser invokes Python with only fixed positional paths", async () => {
  const calls = [];
  const runner = async (...arguments_) => {
    calls.push(arguments_);
  };

  await runPaperParser("python-bin", "worker.py", "source.pdf", "chunks.json", runner);

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "python-bin");
  assert.deepEqual(calls[0][1], ["worker.py", "source.pdf", "chunks.json"]);
  assert.deepEqual(calls[0][2], {
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });
});

test("paper parser propagates runner failures", async () => {
  const expected = new Error("parser exited 7");
  const runner = async () => {
    throw expected;
  };

  await assert.rejects(
    runPaperParser("python-bin", "worker.py", "source.pdf", "chunks.json", runner),
    (error) => error === expected,
  );
});
