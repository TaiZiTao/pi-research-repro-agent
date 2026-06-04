/**
 * Qwen research model safety gate (pure helpers).
 *
 * The local Qwen3 LoRA OpenAI-compatible server can be chosen as the session
 * model. Qwen is a research tool decisioner, never a general assistant: when
 * a session runs on the research-qwen provider its ACTIVE tool set is
 * narrowed to research_* tools only (evidence search, answer verification,
 * reproduction planning). File/bash/browser/process/managed-process tools
 * stay registered but inactive, so Qwen can never take them over.
 */

/** Provider id used in the models config for the local Qwen OpenAI server. */
export const RESEARCH_QWEN_PROVIDER = "research-qwen";

/** True when a tool name belongs to the research tool family. */
export function isResearchToolName(name: string): boolean {
  return name.startsWith("research_");
}

/**
 * Narrow a requested (or all-available) tool list to research tools only.
 *
 * @param availableNames every tool currently registered on the session.
 * @param requestedNames the user-requested active set, or undefined for "all".
 */
export function researchOnlyToolNames(
  availableNames: readonly string[],
  requestedNames: readonly string[] | undefined,
): string[] {
  const source = requestedNames === undefined ? availableNames : requestedNames;
  return [...new Set(source.filter((name) => isResearchToolName(name)))].sort();
}
