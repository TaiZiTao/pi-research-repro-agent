import assert from "node:assert/strict";
import test from "node:test";
import {
  getQwenRoutingMode,
  qwenRoutingModeFromEnv,
  resetQwenRoutingModeForTests,
  setQwenRoutingMode,
} from "./qwen-routing-state.ts";

test("routing mode defaults off and accepts only router or agent", () => {
  assert.equal(qwenRoutingModeFromEnv({}), "off");
  assert.equal(qwenRoutingModeFromEnv({ RESEARCH_QWEN_AGENT: "1" }), "agent");
  assert.equal(qwenRoutingModeFromEnv({ RESEARCH_QWEN_ROUTER: "1" }), "router");
});

test("desktop can change the live routing mode", () => {
  resetQwenRoutingModeForTests("off");
  assert.equal(getQwenRoutingMode(), "off");
  assert.equal(setQwenRoutingMode("agent"), "agent");
  assert.equal(getQwenRoutingMode(), "agent");
  assert.throws(() => setQwenRoutingMode("invalid"), /Invalid Qwen routing mode/);
  resetQwenRoutingModeForTests();
});
