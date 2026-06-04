import assert from "node:assert/strict";
import test from "node:test";
import { qwenServerChildAlive, resetQwenServerForTests, resolveQwenServeConfig } from "./qwen-server.ts";

test.afterEach(() => resetQwenServerForTests());

test("resolveQwenServeConfig uses env overrides with machine defaults", () => {
  const config = resolveQwenServeConfig({
    RESEARCH_QWEN_PYTHON: "C:\\python\\python.exe",
    RESEARCH_QWEN_MODEL: "E:\\models\\qwen",
    RESEARCH_QWEN_ADAPTER: "E:\\adapters\\lora",
    PI_DESKTOP_APP_ROOT: "C:\\app",
  });
  assert.equal(config.python, "C:\\python\\python.exe");
  assert.equal(config.model, "E:\\models\\qwen");
  assert.equal(config.adapter, "E:\\adapters\\lora");
  assert.equal(config.serverPath, "C:\\app\\python\\agent_shadow\\qwen_openai_server.py");
});

test("resolveQwenServeConfig falls back to defaults without env", () => {
  const config = resolveQwenServeConfig({});
  assert.ok(config.python.length > 0);
  assert.ok(config.model.length > 0);
  assert.equal(config.adapter, null);
  assert.match(config.serverPath, /python[\\/]agent_shadow[\\/]qwen_openai_server\.py$/);
});

test("no child process exists before a start call", () => {
  assert.equal(qwenServerChildAlive(), false);
});
