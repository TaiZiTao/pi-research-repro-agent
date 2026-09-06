import assert from "node:assert/strict";
import test from "node:test";
import { verifyGroundedAnswer } from "./citation-verifier.ts";

const paperId = "a".repeat(64);
const chunks = [
  { paperId, chunkId: "p2-c1", page: 2, text: "The proposed method reduces spectral degradation in lightweight SR." },
];

test("accepts real evidence and rejects forged citation fields", () => {
  const valid = {
    status: "grounded",
    answer: "The method targets spectral degradation.",
    citations: [{ paperId, page: 2, chunkId: "p2-c1", quote: "reduces  spectral degradation" }],
  };
  assert.equal(verifyGroundedAnswer(valid, chunks, paperId).accepted, true);

  for (const citation of [
    { ...valid.citations[0], paperId: "b".repeat(64) },
    { ...valid.citations[0], page: 3 },
    { ...valid.citations[0], chunkId: "p9-c9" },
    { ...valid.citations[0], quote: "fabricated result" },
  ]) {
    assert.equal(verifyGroundedAnswer({ ...valid, citations: [citation] }, chunks, paperId).accepted, false);
  }
});

test("grounded answers require citations while evidence-insufficient answers do not", () => {
  assert.equal(
    verifyGroundedAnswer({ status: "grounded", answer: "A claim", citations: [] }, chunks, paperId).accepted,
    false,
  );
  assert.equal(
    verifyGroundedAnswer(
      { status: "insufficient_evidence", answer: "The paper does not provide this information.", citations: [] },
      chunks,
      paperId,
    ).accepted,
    true,
  );
});
