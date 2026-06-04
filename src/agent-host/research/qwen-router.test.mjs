import assert from "node:assert/strict";
import test from "node:test";
import { hasResearchTool, qwenRouterSuggestion, routerEnabledFromEnv, routerSteerPrefix } from "./qwen-router.ts";

function fakePredictor(result) {
  return {
    mode: "shadow",
    async predict() {
      return result;
    },
    close() {},
  };
}

test("router is off by default and env-gated", () => {
  assert.equal(routerEnabledFromEnv({}), false);
  assert.equal(routerEnabledFromEnv({ RESEARCH_QWEN_ROUTER: "1" }), true);
  assert.equal(routerEnabledFromEnv({ RESEARCH_QWEN_ROUTER: "0" }), false);
});

test("hasResearchTool detects research tools in the active set", () => {
  assert.equal(hasResearchTool(["bash", "research_search_evidence"]), true);
  assert.equal(hasResearchTool(["bash", "files.read"]), false);
  assert.equal(hasResearchTool([]), false);
});

test("suggestion is dropped for answer, invalid, unknown or inactive actions", async () => {
  const active = ["research_search_evidence", "research_finalize_answer"];
  const ctx = [{ role: "user", content: "q" }];
  assert.equal(await qwenRouterSuggestion(fakePredictor({ action: "__answer__", arguments: {} }), ctx, active), null);
  assert.equal(await qwenRouterSuggestion(fakePredictor({ action: "__invalid__", arguments: {} }), ctx, active), null);
  assert.equal(await qwenRouterSuggestion(fakePredictor(null), ctx, active), null);
  assert.equal(await qwenRouterSuggestion(fakePredictor({ action: "bash", arguments: {} }), ctx, active), null);
  assert.equal(
    await qwenRouterSuggestion(fakePredictor({ action: "research_search_papers", arguments: {} }), ctx, active),
    null,
  );
  assert.equal(
    await qwenRouterSuggestion(fakePredictor({ action: "research_search_evidence", arguments: {} }), ctx, []),
    null,
  );
});

test("active research suggestion is returned with its arguments", async () => {
  const active = ["research_search_evidence", "research_finalize_answer"];
  const ctx = [{ role: "user", content: "q" }];
  const suggestion = await qwenRouterSuggestion(
    fakePredictor({ action: "research_search_evidence", arguments: { query: "loss function", limit: 5 } }),
    ctx,
    active,
  );
  assert.deepEqual(suggestion, { name: "research_search_evidence", arguments: { query: "loss function", limit: 5 } });
});

test("steer prefix names the tool and keeps the user question", () => {
  const prefix = routerSteerPrefix(
    { name: "research_search_evidence", arguments: { query: "main contribution" } },
    "这篇论文的主要贡献是什么",
  );
  assert.match(prefix, /research_search_evidence/);
  assert.match(prefix, /main contribution/);
  assert.match(prefix, /这篇论文的主要贡献是什么/);
  assert.match(prefix, /真实工具结果/);
});
