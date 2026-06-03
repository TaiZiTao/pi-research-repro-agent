import assert from "node:assert/strict";
import test from "node:test";
import { assertResearchTransition } from "./state-machine.ts";

test("phase-one import follows acquiring -> ingesting -> ready", () => {
  assert.doesNotThrow(() => assertResearchTransition("created", "acquiring"));
  assert.doesNotThrow(() => assertResearchTransition("acquiring", "ingesting"));
  assert.doesNotThrow(() => assertResearchTransition("ingesting", "ready"));
});

test("failed projects cannot silently resume", () => {
  assert.throws(() => assertResearchTransition("failed", "ready"), /illegal research transition/);
});

test("ingestion may fail or be cancelled", () => {
  assert.doesNotThrow(() => assertResearchTransition("ingesting", "failed"));
  assert.doesNotThrow(() => assertResearchTransition("ingesting", "cancelled"));
});
