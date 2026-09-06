import assert from "node:assert/strict";
import test from "node:test";
import { mapCandidatesFromResult, mapEvidenceFromResult, mapWorkflowStages } from "./mapping.ts";

test("maps research_search_papers result into candidate cards", () => {
  const cards = mapCandidatesFromResult(
    JSON.stringify({
      candidates: [
        {
          id: "2401.00001",
          title: "A Paper",
          authors: ["A", "B"],
          year: 2024,
          venue: null,
          abstract: "abs",
          pdfUrl: "https://arxiv.org/pdf/1",
          source: "arxiv",
        },
        {
          id: "W1",
          title: "No PDF",
          authors: [],
          year: null,
          venue: null,
          abstract: null,
          pdfUrl: null,
          source: "openalex",
        },
      ],
    }),
  );
  assert.equal(cards.length, 2);
  assert.equal(cards[0].title, "A Paper");
  assert.equal(cards[0].pdfAvailable, true);
  assert.deepEqual(cards[0].authors, ["A", "B"]);
  assert.equal(cards[1].pdfAvailable, false);
});

test("candidate parsing tolerates malformed input", () => {
  assert.deepEqual(mapCandidatesFromResult("not json"), []);
  assert.deepEqual(mapCandidatesFromResult(JSON.stringify({ hits: [] })), []);
  assert.deepEqual(mapCandidatesFromResult(""), []);
});

test("maps evidence hits with page and chunk id", () => {
  const rows = mapEvidenceFromResult(JSON.stringify({ hits: [{ page: 3, chunkId: "p3-c1", text: "x", score: 0.9 }] }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].page, 3);
  assert.equal(rows[0].chunkId, "p3-c1");
  assert.equal(rows[0].score, 0.9);
});

test("workflow mapping shows pending before a project exists", () => {
  const stages = mapWorkflowStages(null, null);
  assert.ok(stages.every((stage) => stage.state === "pending"));
  assert.equal(stages.length, 8);
  assert.equal(stages[0].id, "acquire");
  assert.equal(stages[7].id, "verify");
});

test("ready project only marks acquisition and parsing succeeded", () => {
  const stages = mapWorkflowStages({ status: "ready", error: null }, null);
  const byId = Object.fromEntries(stages.map((s) => [s.id, s.state]));
  assert.equal(byId.acquire, "succeeded");
  assert.equal(byId.parse, "succeeded");
  assert.equal(byId.execute, "pending");
  assert.equal(byId.verify, "pending");
});

test("completed reproduction verifies only after deterministic acceptance", () => {
  const stages = mapWorkflowStages(
    { status: "ready", error: null },
    { phase: "completed", steps: [{ status: "succeeded" }, { status: "succeeded" }], agentReproduction: true },
  );
  const byId = Object.fromEntries(stages.map((s) => [s.id, s.state]));
  assert.equal(byId.verify, "succeeded");
  assert.equal(byId.execute, "succeeded");
  assert.equal(byId.plan, "succeeded");
});

test("a failed step never shows execute or verify as succeeded", () => {
  const stages = mapWorkflowStages(
    { status: "ready", error: null },
    { phase: "running", steps: [{ status: "failed" }], agentReproduction: true },
  );
  const byId = Object.fromEntries(stages.map((s) => [s.id, s.state]));
  assert.equal(byId.execute, "failed");
  assert.notEqual(byId.verify, "succeeded");
});
