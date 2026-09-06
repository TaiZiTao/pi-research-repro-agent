import assert from "node:assert/strict";
import test from "node:test";
import { searchEvidence } from "./evidence-search.ts";

const chunks = [
  { paperId: "paper", chunkId: "p3-c1", page: 3, text: "Loss appears once." },
  { paperId: "paper", chunkId: "p2-c2", page: 2, text: "Training loss and validation error." },
  { paperId: "paper", chunkId: "p2-c1", page: 2, text: "Validation loss curves." },
  { paperId: "paper", chunkId: "p1-c1", page: 1, text: "An unrelated abstract." },
  { paperId: "paper", chunkId: "p4-c1", page: 4, text: "中文证据检索" },
];

test("ranks lexical overlap by score, page, then chunk identifier", () => {
  assert.deepEqual(
    searchEvidence(chunks, "validation loss").map(({ chunkId, score }) => ({ chunkId, score })),
    [
      { chunkId: "p2-c1", score: 2 },
      { chunkId: "p2-c2", score: 2 },
      { chunkId: "p3-c1", score: 1 },
    ],
  );
});

test("matches Han characters individually", () => {
  const hits = searchEvidence(chunks, "证据");

  assert.equal(hits.length, 1);
  assert.equal(hits[0].chunkId, "p4-c1");
  assert.equal(hits[0].score, 2);
});

test("returns no zero-overlap hits", () => {
  assert.deepEqual(searchEvidence(chunks, "quantum"), []);
  assert.deepEqual(searchEvidence(chunks, "!!!"), []);
});

test("clamps result limits to one through eight", () => {
  const many = Array.from({ length: 10 }, (_, index) => ({
    paperId: "paper",
    chunkId: `p${index + 1}-c1`,
    page: index + 1,
    text: "shared",
  }));

  assert.equal(searchEvidence(many, "shared", 0).length, 1);
  assert.equal(searchEvidence(many, "shared", 100).length, 8);
});

test("does not mutate input chunks", () => {
  const original = structuredClone(chunks);

  searchEvidence(chunks, "loss", 3);

  assert.deepEqual(chunks, original);
});
