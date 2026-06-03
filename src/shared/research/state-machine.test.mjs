import assert from "node:assert/strict";
import test from "node:test";
import { assertResearchTransition } from "./state-machine.ts";

const statuses = ["created", "acquiring", "ingesting", "ready", "failed", "cancelled"];
const legalTransitions = [
  ["created", "acquiring"],
  ["created", "cancelled"],
  ["acquiring", "ingesting"],
  ["acquiring", "failed"],
  ["acquiring", "cancelled"],
  ["ingesting", "ready"],
  ["ingesting", "failed"],
  ["ingesting", "cancelled"],
];

test("allows every legal phase-one research transition", () => {
  for (const [from, to] of legalTransitions) {
    assert.doesNotThrow(() => assertResearchTransition(from, to), `${from} -> ${to}`);
  }
});

test("ready, failed, and cancelled projects are terminal", () => {
  for (const from of ["ready", "failed", "cancelled"]) {
    for (const to of statuses) {
      assert.throws(() => assertResearchTransition(from, to), /illegal research transition/, `${from} -> ${to}`);
    }
  }
});
