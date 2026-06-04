import { RESEARCH_QWEN_BASE_URL } from "./qwen-server.ts";
import type { ShadowPrediction } from "./qwen-shadow.ts";

export interface QwenToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: unknown;
  };
}

export interface QwenRouterPredictor {
  predict(
    messages: Array<{ role: string; content: string }>,
    tools: readonly QwenToolSchema[],
  ): Promise<ShadowPrediction | null>;
}

interface QwenHttpPredictorOptions {
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

function parseArguments(value: unknown): { value: Record<string, unknown>; valid: boolean } {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return { value: value as Record<string, unknown>, valid: true };
  }
  if (typeof value !== "string") return { value: {}, valid: false };
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { value: parsed as Record<string, unknown>, valid: true };
    }
  } catch {
    // Invalid model output degrades to no suggestion.
  }
  return { value: {}, valid: false };
}

/** Use the one desktop-managed OpenAI-compatible Qwen service for routing. */
export function createQwenHttpPredictor(options: QwenHttpPredictorOptions = {}): QwenRouterPredictor {
  const request = options.fetch ?? fetch;
  const endpoint = `${(options.baseUrl ?? RESEARCH_QWEN_BASE_URL).replace(/\/$/, "")}/chat/completions`;
  const timeoutMs = options.timeoutMs ?? 30_000;
  return {
    async predict(messages, tools) {
      const startedAt = Date.now();
      try {
        const response = await request(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "qwen3-0.6b-lora",
            messages,
            tools,
            temperature: 0,
            stream: false,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) return null;
        const payload = (await response.json()) as {
          choices?: Array<{
            message?: {
              content?: unknown;
              tool_calls?: Array<{ function?: { name?: unknown; arguments?: unknown } }>;
            };
          }>;
        };
        const message = payload.choices?.[0]?.message;
        const call = message?.tool_calls?.[0]?.function;
        if (!call || typeof call.name !== "string" || !call.name) {
          return { action: "__answer__", arguments: {}, jsonValid: true, latencyMs: Date.now() - startedAt };
        }
        const parsed = parseArguments(call.arguments);
        if (!parsed.valid) return null;
        return {
          action: call.name,
          arguments: parsed.value,
          jsonValid: true,
          latencyMs: Date.now() - startedAt,
        };
      } catch {
        return null;
      }
    },
  };
}
