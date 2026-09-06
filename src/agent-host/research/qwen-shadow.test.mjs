import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import test from "node:test";
import {
  createQwenShadow,
  fromEnv,
  logShadowRecord,
  QwenShadowPredictor,
  redactArguments,
  sha256Short,
} from "./qwen-shadow.ts";

function makeChild() {
  const child = new EventEmitter();
  const stdout = new Readable({ read() {} });
  child.stdout = stdout;
  child.stdin = {
    write(value) {
      if (!child.written) child.written = [];
      child.written.push(String(value));
      return true;
    },
  };
  child.kill = () => {
    stdout.push(null);
    child.emit("exit", 0);
  };
  child.emitLine = (line) => stdout.push(line + "\n");
  return child;
}

function configWith(spawnFn) {
  return {
    mode: "shadow",
    python: "python",
    workerPath: "python/agent_shadow/qwen_shadow_worker.py",
    model: "E:\\deepseek\\models\\Qwen3-0.6B",
    adapter: "training/outputs/qwen3-0.6b-lora-answer-1.5/adapter",
    logPath: "",
    timeoutMs: 2000,
    spawn: spawnFn,
  };
}

function lastRequest(child) {
  const raw = child.written[child.written.length - 1];
  return JSON.parse(raw);
}

test("fromEnv defaults to off and enables shadow explicitly", () => {
  const off = fromEnv({});
  assert.equal(off.mode, "off");
  const on = fromEnv({ RESEARCH_QWEN_MODE: "shadow", RESEARCH_QWEN_ADAPTER: "a" });
  assert.equal(on.mode, "shadow");
  assert.equal(on.adapter, "a");
});

test("redactArguments scrubs tokens and local paths", () => {
  const out = redactArguments({
    url: "https://example.org/x",
    path: "C:\\Users\\17093\\secret.txt",
    token: "ghp_abcdefghijklmnop",
    limit: 5,
  });
  assert.equal(out.path, "[redacted-path]");
  assert.equal(out.token, "[redacted-token]");
  assert.equal(out.url, "https://example.org/x");
  assert.equal(out.limit, 5);
});

test("off mode never spawns and always predicts null", async () => {
  let spawned = 0;
  const shadow = createQwenShadow({
    ...configWith(() => {
      spawned += 1;
      return makeChild();
    }),
    mode: "off",
  });
  const result = await shadow.predict([{ role: "user", content: "hi" }]);
  assert.equal(result, null);
  assert.equal(spawned, 0);
  assert.equal(shadow.mode, "off");
  shadow.close();
});

test("shadow mode spawns once and resolves a prediction", async () => {
  const child = makeChild();
  const shadow = createQwenShadow(configWith(() => child));
  const promise = shadow.predict([
    { role: "system", content: "s" },
    { role: "user", content: "问" },
  ]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  child.emitLine(JSON.stringify({ event: "ready" }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const request = lastRequest(child);
  assert.equal(request.messages.length, 2);
  child.emitLine(
    JSON.stringify({
      id: request.id,
      ok: true,
      action: "research_search_evidence",
      arguments: { query: "x" },
      jsonValid: true,
      latencyMs: 12.3,
    }),
  );
  const result = await promise;
  assert.deepEqual(result, {
    action: "research_search_evidence",
    arguments: { query: "x" },
    jsonValid: true,
    latencyMs: 12.3,
  });
  shadow.close();
});

test("worker errors and exits degrade to null without throwing", async () => {
  const child = makeChild();
  const shadow = createQwenShadow(configWith(() => child));
  const p1 = shadow.predict([{ role: "user", content: "q" }]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  child.emitLine(JSON.stringify({ event: "ready" }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const req = lastRequest(child);
  child.emitLine(JSON.stringify({ id: req.id, ok: false, error: "predict-failed" }));
  assert.equal(await p1, null);
  const p2 = shadow.predict([{ role: "user", content: "q2" }]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  child.kill();
  assert.equal(await p2, null);
});

test("logShadowRecord writes one redacted JSONL line", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-shadow-log-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const logPath = path.join(dir, "shadow.jsonl");
  logShadowRecord(
    {
      ts: "2026-09-04T00:00:00.000Z",
      sessionHash: sha256Short("session-1"),
      qwen: {
        action: "research_download_paper",
        arguments: { url: "https://arxiv.org/pdf/1", path: "C:\\Users\\x\\p.pdf" },
        jsonValid: true,
        latencyMs: 5,
      },
      deepseek: { action: "research_download_paper", arguments: { path: "C:\\Users\\x\\p.pdf" } },
      match: true,
    },
    { sessionId: "session-1", logPath },
  );
  const line = readFileSync(logPath, "utf8").trim();
  const record = JSON.parse(line);
  assert.equal(record.sessionHash, sha256Short("session-1"));
  assert.equal(record.qwen.arguments.path, "[redacted-path]");
  assert.equal(record.deepseek.arguments.path, "[redacted-path]");
  assert.equal(record.qwen.arguments.url, "https://arxiv.org/pdf/1");
  assert.equal(record.match, true);
  assert.ok(!record.ts || record.ts.length > 0);
});

test("QwenShadowPredictor requires an adapter before spawning", async () => {
  let spawned = 0;
  const cfg = {
    ...configWith(() => {
      spawned += 1;
      return makeChild();
    }),
    adapter: null,
  };
  const predictor = new QwenShadowPredictor(cfg);
  const result = await predictor.predict([{ role: "user", content: "x" }]);
  assert.equal(result, null);
  assert.equal(spawned, 0);
  predictor.close();
});
