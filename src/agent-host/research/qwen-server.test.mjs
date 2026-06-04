import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
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

test("resolveQwenServeConfig automatically selects the bundled trained adapter", () => {
  const appRoot = path.resolve(import.meta.dirname, "..", "..", "..");
  const config = resolveQwenServeConfig({ PI_DESKTOP_APP_ROOT: appRoot });
  assert.ok(config.python.length > 0);
  assert.ok(config.model.length > 0);
  assert.equal(config.adapter, path.join(appRoot, "training", "outputs", "qwen3-0.6b-lora-answer-1.5", "adapter"));
  assert.match(config.serverPath, /python[\\/]agent_shadow[\\/]qwen_openai_server\.py$/);
});

test("no child process exists before a start call", () => {
  assert.equal(qwenServerChildAlive(), false);
});
