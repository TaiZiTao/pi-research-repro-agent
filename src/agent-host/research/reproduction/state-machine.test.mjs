import assert from "node:assert/strict";
import test from "node:test";
import { assertReproductionTransition, canRepair, isTerminal } from "./state-machine.ts";
import { MAX_REPAIR_ROUNDS } from "./types.ts";

const phases = ["planned", "preparing", "running", "verifying", "completed", "blocked"];
const legalTransitions = [
  ["planned", "preparing"],
  ["preparing", "running"],
  ["preparing", "blocked"],
  ["running", "verifying"],
  ["running", "blocked"],
  ["verifying", "completed"],
  ["verifying", "blocked"],
  ["verifying", "running"],
];

test("allows every legal reproduction transition", () => {
  for (const [from, to] of legalTransitions) {
    assert.doesNotThrow(() => assertReproductionTransition(from, to), `${from} -> ${to}`);
  }
});

test("rejects every illegal reproduction transition", () => {
  const illegalTransitions = [
    ["planned", "running"],
    ["planned", "blocked"],
    ["planned", "completed"],
    ["planned", "planned"],
    ["preparing", "verifying"],
    ["preparing", "completed"],
    ["preparing", "planned"],
    ["running", "completed"],
    ["running", "preparing"],
    ["running", "planned"],
    ["verifying", "preparing"],
    ["verifying", "planned"],
    ["completed", "running"],
    ["completed", "verifying"],
    ["blocked", "running"],
    ["blocked", "planned"],
  ];
  for (const [from, to] of illegalTransitions) {
    assert.throws(() => assertReproductionTransition(from, to), /illegal reproduction transition/, `${from} -> ${to}`);
  }
});

test("completed and blocked phases are terminal", () => {
  for (const phase of ["completed", "blocked"]) {
    assert.equal(isTerminal(phase), true);
    for (const to of phases) {
      assert.throws(
        () => assertReproductionTransition(phase, to),
        /illegal reproduction transition/,
        `${phase} -> ${to}`,
      );
    }
  }
  for (const phase of ["planned", "preparing", "running", "verifying"]) {
    assert.equal(isTerminal(phase), false);
  }
});

test("canRepair gates repair rounds at MAX_REPAIR_ROUNDS for the verifying phase", () => {
  assert.equal(MAX_REPAIR_ROUNDS, 3);
  assert.equal(canRepair("verifying", 0), true);
  assert.equal(canRepair("verifying", 2), true);
  assert.equal(canRepair("verifying", 3), false);
  assert.equal(canRepair("verifying", 4), false);
  assert.equal(canRepair("verifying", -1), false);
  assert.equal(canRepair("running", 0), false);
  assert.equal(canRepair("running", 2), false);
  assert.equal(canRepair("completed", 2), false);
  assert.equal(canRepair("blocked", 0), false);
});
