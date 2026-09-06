import assert from "node:assert/strict";
import test from "node:test";
import { RESEARCH_QWEN_PROVIDER, isResearchToolName, researchOnlyToolNames } from "./qwen-tools.ts";

test("research provider constant is stable", () => {
  assert.equal(RESEARCH_QWEN_PROVIDER, "research-qwen");
});

test("isResearchToolName recognizes the research tool family only", () => {
  assert.equal(isResearchToolName("research_search_evidence"), true);
  assert.equal(isResearchToolName("research_finalize_answer"), true);
  assert.equal(isResearchToolName("research_plan_reproduction"), true);
  assert.equal(isResearchToolName("bash"), false);
  assert.equal(isResearchToolName("browser_navigate"), false);
  assert.equal(isResearchToolName("files.read"), false);
  assert.equal(isResearchToolName("managed_process_start"), false);
  assert.equal(isResearchToolName("research_evil"), true);
});

test("researchOnlyToolNames narrows the requested set to research tools", () => {
  const available = ["bash", "research_search_evidence", "browser_navigate", "research_finalize_answer", "files.write"];
  assert.deepEqual(researchOnlyToolNames(available, undefined), [
    "research_finalize_answer",
    "research_search_evidence",
  ]);
  assert.deepEqual(researchOnlyToolNames(available, ["bash", "files.write"]), []);
  assert.deepEqual(researchOnlyToolNames(available, ["research_search_evidence", "bash"]), [
    "research_search_evidence",
  ]);
  assert.deepEqual(researchOnlyToolNames([], undefined), []);
});

test("researchOnlyToolNames deduplicates and never returns non-research names", () => {
  const available = ["research_a", "research_a", "bash", "research_b"];
  const narrowed = researchOnlyToolNames(available, undefined);
  assert.deepEqual(narrowed, ["research_a", "research_b"]);
  assert.ok(narrowed.every((name) => name.startsWith("research_")));
});
