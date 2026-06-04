/**
 * Qwen autonomous execution chain (env RESEARCH_QWEN_AGENT=1).
 *
 * Up to N steps: the local decisioner picks a tool, the HOST executes it
 * (read-only research tools only, still validated against the session
 * active tool set), and the real result is fed back as text before the
 * next decision. When the model answers (__answer__), suggests a
 * state-changing tool (finalize/plan/configure/execute/download/...), or
 * reaches the step cap, the chain stops: the evidence trace and any
 * pending action are handed to DeepSeek, which executes state-changing
 * tools through the normal host gates and produces the final answer.
 */

/** Read-only research tools the host may execute on the model behalf. */
export const READONLY_RESEARCH_TOOLS: ReadonlySet<string> = new Set([
  "research_search_evidence",
  "research_search_papers",
  "research_search_repositories",
]);

/** Step cap for one user message. */
export const QWEN_AGENT_MAX_STEPS = 4;

export interface AgentStep {
  index: number;
  action: string;
  arguments: Record<string, unknown>;
  ok: boolean;
  /** Real, bounded tool result text. */
  summary: string;
}

export interface AgentChainResult {
  steps: AgentStep[];
  /** A state-changing tool the model wants next; DeepSeek must run it. */
  pendingAction: { name: string; arguments: Record<string, unknown> } | null;
  /** True when the model said answer/no-tool at the very first decision. */
  answeredImmediately: boolean;
}

/** Env switch; default off so ordinary DeepSeek sessions are untouched. */
export function agentEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.RESEARCH_QWEN_AGENT === "1";
}

export interface AgentToolExecutor {
  (action: string, arguments_: Record<string, unknown>): Promise<{ ok: boolean; summary: string }>;
}

export interface AgentDecider {
  (context: Array<{ role: string; content: string }>): Promise<{
    action: string;
    arguments: Record<string, unknown>;
  } | null>;
}

/**
 * Pure control flow: decide → execute (read-only) → feed back → decide.
 * Never throws; executor failures stop the chain with the steps so far.
 */
export async function runQwenAgentChain(opts: {
  decider: AgentDecider;
  executor: AgentToolExecutor;
  context: Array<{ role: string; content: string }>;
  maxSteps?: number;
}): Promise<AgentChainResult> {
  const maxSteps = opts.maxSteps ?? QWEN_AGENT_MAX_STEPS;
  const context = [...opts.context];
  const steps: AgentStep[] = [];
  let pendingAction: AgentChainResult["pendingAction"] = null;
  for (let index = 1; index <= maxSteps; index += 1) {
    const decision = await opts.decider(context).catch(() => null);
    if (!decision) break;
    const { action, arguments: arguments_ } = decision;
    if (!READONLY_RESEARCH_TOOLS.has(action)) {
      pendingAction = { name: action, arguments: arguments_ };
      break;
    }
    const outcome = await opts.executor(action, arguments_).catch(() => ({ ok: false, summary: "" }));
    steps.push({ index, action, arguments: arguments_, ok: outcome.ok, summary: outcome.summary });
    if (!outcome.ok) break;
    context.push({ role: "assistant", content: "调用 " + action + " 参数 " + JSON.stringify(arguments_) });
    context.push({ role: "user", content: "工具结果:" + outcome.summary });
  }
  // answeredImmediately: the very first decision was "no tool", so DeepSeek
  // should answer freely without any injected trace.
  return {
    steps,
    pendingAction,
    answeredImmediately: steps.length === 0 && pendingAction === null,
  };
}

/**
 * Build the final DeepSeek prompt from the chain trace: real tool results
 * plus a pending state-changing action for DeepSeek to run and answer from.
 */
export function buildAgentPrompt(question: string, result: AgentChainResult): string {
  const parts: string[] = [];
  if (result.steps.length > 0) {
    parts.push("[科研证据链(本地 Qwen 自主检索,工具结果真实)]");
    for (const step of result.steps) {
      parts.push("步骤" + step.index + ": " + step.action + " 参数 " + JSON.stringify(step.arguments));
      parts.push("结果:" + step.summary);
    }
  }
  if (result.pendingAction) {
    parts.push(
      "还需执行(请由你完成):" + result.pendingAction.name + " 参数 " + JSON.stringify(result.pendingAction.arguments),
    );
  }
  parts.push("请基于以上真实检索/工具结果回答下面的问题;引用注明页码或块号,不得编造证据或数字。");
  parts.push("用户问题:" + question);
  return parts.join("\n");
}
