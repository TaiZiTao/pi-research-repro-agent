/**
 * Qwen local tool router: DeepSeek stays the main conversational model;
 * before each user prompt (when enabled) Qwen3-0.6B LoRA is consulted for
 * "should a tool run, which one, with what simple arguments". The router
 * never executes tools itself and never decides on its own:
 *   - __answer__ / __invalid__ → no suggestion (DeepSeek answers freely);
 *   - a suggested action outside the session ACTIVE tool set is dropped;
 *   - only research_* actions may ever be suggested;
 *   - the suggestion is turned into a steer prefix for DeepSeek, which
 *     then runs the real tool through the Pi host (safety gates apply).
 * This replaces the former (wrong) design where Qwen was selectable as the
 * session main model and looped on "tool not found".
 */

import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { isResearchToolName } from "./qwen-tools.ts";
import type { ShadowPredictor } from "./qwen-shadow.ts";

export interface RouterSuggestion {
  name: string;
  arguments: Record<string, unknown>;
}

/** Env switch; default off so ordinary DeepSeek sessions are untouched. */
export function routerEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.RESEARCH_QWEN_ROUTER === "1";
}

/**
 * Ask the local decisioner for the next action and filter it against the
 * session active tool set. Returns null when the model answered (no tool),
 * failed, or suggested something outside the active set.
 */
export async function qwenRouterSuggestion(
  predictor: ShadowPredictor,
  context: Array<{ role: string; content: string }>,
  activeToolNames: readonly string[],
): Promise<RouterSuggestion | null> {
  if (activeToolNames.length === 0) return null;
  const prediction = await predictor.predict(context);
  if (!prediction) return null;
  const { action } = prediction;
  if (action === "__answer__" || action === "__invalid__") return null;
  if (!isResearchToolName(action) || !activeToolNames.includes(action)) return null;
  return { name: action, arguments: prediction.arguments ?? {} };
}

/**
 * A short steer prefix telling DeepSeek to run the suggested tool through the
 * real host and answer from its actual result. Bounded to keep prompts small.
 */
export function routerSteerPrefix(suggestion: RouterSuggestion, userText: string): string {
  const args = JSON.stringify(suggestion.arguments ?? {}, undefined, 0).slice(0, 500);
  const trimmed = userText.slice(0, 300);
  return (
    "[本地路由决策器] 建议先调用工具 " +
    suggestion.name +
    "(参数 " +
    args +
    ") 回答这条请求:" +
    trimmed +
    "。请务必调用该工具并严格按真实工具结果作答;工具不可用或结果不足时如实说明,不要编造引用或数字。"
  );
}

/** True when any active tool belongs to the research family. */
export function hasResearchTool(activeToolNames: readonly string[]): boolean {
  return activeToolNames.some((name) => isResearchToolName(name));
}
export interface RouterLogRecord {
  ts: string;
  sessionHash: string;
  kind: "router_suggestion" | "deepseek_tool_calls";
  suggestion?: { name: string; arguments: Record<string, unknown> } | null;
  tools?: string[];
  userPreview?: string;
}

/** Best-effort JSONL record; never throws into the prompt path. */
export function appendRouterLog(logPath: string, record: RouterLogRecord): void {
  if (!logPath) return;
  try {
    mkdirSync(path.dirname(logPath), { recursive: true });
    appendFileSync(logPath, JSON.stringify(record) + "\n", "utf8");
  } catch {
    /* logging is best-effort */
  }
}
