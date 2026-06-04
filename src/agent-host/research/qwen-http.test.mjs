import assert from "node:assert/strict";
import test from "node:test";
import { createQwenHttpPredictor } from "./qwen-http.ts";

test("HTTP predictor sends the current session tool schemas and parses a tool call", async () => {
  let requestBody;
  const predictor = createQwenHttpPredictor({
    fetch: async (_url, init) => {
      requestBody = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    function: {
                      name: "research_search_evidence",
                      arguments: JSON.stringify({ query: "loss", limit: 3 }),
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  const tools = [
    {
      type: "function",
      function: {
        name: "research_search_evidence",
        description: "Search evidence",
        parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      },
    },
  ];

  const result = await predictor.predict([{ role: "user", content: "损失函数是什么" }], tools);

  assert.deepEqual(requestBody.tools, tools);
  assert.equal(requestBody.stream, false);
  assert.equal(result.action, "research_search_evidence");
  assert.deepEqual(result.arguments, { query: "loss", limit: 3 });
  assert.equal(result.jsonValid, true);
  assert.ok(result.latencyMs >= 0);
});

test("HTTP predictor maps a plain response to answer and degrades on failures", async () => {
  const answer = createQwenHttpPredictor({
    fetch: async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "直接回答" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  assert.equal((await answer.predict([{ role: "user", content: "你是谁" }], [])).action, "__answer__");

  const failed = createQwenHttpPredictor({ fetch: async () => new Response("boom", { status: 500 }) });
  assert.equal(await failed.predict([{ role: "user", content: "x" }], []), null);
});
