import assert from "node:assert/strict";
import test from "node:test";
import { READONLY_RESEARCH_TOOLS, agentEnabledFromEnv, buildAgentPrompt, runQwenAgentChain } from "./qwen-agent.ts";

function deciderFrom(decisions) {
  let i = 0;
  return async () => {
    const d = decisions[Math.min(i, decisions.length - 1)];
    i += 1;
    return d;
  };
}

test("agent is env-gated and read-only set is research-only", () => {
  assert.equal(agentEnabledFromEnv({}), false);
  assert.equal(agentEnabledFromEnv({ RESEARCH_QWEN_AGENT: "1" }), true);
  assert.ok(READONLY_RESEARCH_TOOLS.has("research_search_evidence"));
  assert.ok(!READONLY_RESEARCH_TOOLS.has("research_finalize_answer"));
  assert.ok(!READONLY_RESEARCH_TOOLS.has("bash"));
});

test("single read-only step then answer yields one executed tool", async () => {
  const executed = [];
  const result = await runQwenAgentChain({
    decider: deciderFrom([
      { action: "research_search_evidence", arguments: { query: "loss" } },
      null, // __answer__ / no tool
    ]),
    executor: async (action, args) => {
      executed.push([action, args]);
      return { ok: true, summary: JSON.stringify({ hits: [{ page: 1 }] }) };
    },
    context: [{ role: "user", content: "q" }],
  });
  assert.equal(executed.length, 1);
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].action, "research_search_evidence");
  assert.equal(result.steps[0].ok, true);
  assert.equal(result.pendingAction, null);
  assert.equal(result.answeredImmediately, false);
});

test("state-changing suggestion stops the chain and becomes pendingAction", async () => {
  const result = await runQwenAgentChain({
    decider: deciderFrom([{ action: "research_finalize_answer", arguments: { status: "grounded" } }]),
    executor: async () => ({ ok: true, summary: "should not run" }),
    context: [],
  });
  assert.equal(result.steps.length, 0);
  assert.deepEqual(result.pendingAction, { name: "research_finalize_answer", arguments: { status: "grounded" } });
});

test("executor failure stops the chain and keeps partial steps", async () => {
  const result = await runQwenAgentChain({
    decider: deciderFrom([{ action: "research_search_papers", arguments: { query: "x" } }]),
    executor: async () => ({ ok: false, summary: "boom" }),
    context: [],
  });
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].ok, false);
});

test("immediate answer leaves the chain empty", async () => {
  const result = await runQwenAgentChain({
    decider: deciderFrom([null]),
    executor: async () => ({ ok: true, summary: "" }),
    context: [],
  });
  assert.equal(result.steps.length, 0);
  assert.equal(result.answeredImmediately, true);
});

test("step cap is enforced", async () => {
  const result = await runQwenAgentChain({
    decider: deciderFrom([{ action: "research_search_evidence", arguments: {} }]),
    executor: async () => ({ ok: true, summary: "hit" }),
    context: [],
    maxSteps: 3,
  });
  assert.equal(result.steps.length, 3);
  assert.equal(result.answeredImmediately, false);
});

test("buildAgentPrompt includes trace, question and pending action", () => {
  const prompt = buildAgentPrompt("论文贡献是什么", {
    steps: [
      {
        index: 1,
        action: "research_search_evidence",
        arguments: { query: "contribution" },
        ok: true,
        summary: '{"hits":[{"page":1}]}',
      },
    ],
    pendingAction: { name: "research_finalize_answer", arguments: { status: "grounded" } },
    answeredImmediately: false,
  });
  assert.match(prompt, /research_search_evidence/);
  assert.match(prompt, /research_finalize_answer/);
  assert.match(prompt, /用户问题:论文贡献是什么/);
  assert.ok(prompt.includes('{"hits":[{"page":1}]}'));
});
