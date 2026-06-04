/* Pure helpers for the research desktop panel: candidate cards and the 8-stage
 * workflow mapping. Kept side-effect free so they are unit-testable. */

export interface CandidateCard {
  id: string;
  title: string;
  authors: string[];
  year: number | null;
  venue: string | null;
  abstract: string | null;
  pdfAvailable: boolean;
  source: string;
  pdfUrl: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Parse a research_search_papers tool result into candidate cards. */
export function mapCandidatesFromResult(resultText: string): CandidateCard[] {
  if (!resultText) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultText);
  } catch {
    return [];
  }
  const record = asRecord(parsed);
  const list = record?.candidates;
  if (!Array.isArray(list)) return [];
  const cards: CandidateCard[] = [];
  for (const item of list) {
    const candidate = asRecord(item);
    if (!candidate) continue;
    const id = typeof candidate.id === "string" ? candidate.id : "";
    const title = typeof candidate.title === "string" ? candidate.title : "";
    if (!id || !title) continue;
    const authors = Array.isArray(candidate.authors)
      ? candidate.authors.filter((author): author is string => typeof author === "string")
      : [];
    const year = typeof candidate.year === "number" ? candidate.year : null;
    const venue = typeof candidate.venue === "string" ? candidate.venue : null;
    const abstract = typeof candidate.abstract === "string" ? candidate.abstract : null;
    const pdfUrl = typeof candidate.pdfUrl === "string" ? candidate.pdfUrl : null;
    const source = typeof candidate.source === "string" ? candidate.source : "unknown";
    cards.push({ id, title, authors, year, venue, abstract, pdfAvailable: pdfUrl !== null, source, pdfUrl });
  }
  return cards;
}

export type WorkflowState = "pending" | "running" | "succeeded" | "failed" | "blocked";

export interface WorkflowStage {
  id: "acquire" | "parse" | "evidence" | "repo" | "plan" | "configure" | "execute" | "verify";
  label: string;
  state: WorkflowState;
}

export interface ReproductionViewInput {
  phase: string;
  steps: Array<{ status: string }>;
  agentReproduction: boolean;
}

/*
 * Demo-grade mapping from real backend state. Only ready/completed are ever
 * shown as succeeded; nothing is inferred from side effects we cannot see.
 */
export function mapWorkflowStages(
  project: { status: string; error: string | null } | null | undefined,
  reproduction: ReproductionViewInput | null | undefined,
): WorkflowStage[] {
  const status = project?.status ?? "none";
  const failed = project?.error != null || status === "failed";
  const ready = status === "ready";
  const reproPhase = reproduction?.phase ?? "none";
  const completed = reproPhase === "completed";
  const blocked = reproPhase === "blocked";
  const runningRepro = reproPhase === "running" || reproPhase === "verifying" || reproPhase === "preparing";
  const anyStepStarted = (reproduction?.steps ?? []).some((step) => step.status !== "pending");
  const anyStepFailed = (reproduction?.steps ?? []).some((step) => step.status === "failed");
  const acquire: WorkflowState = failed
    ? "failed"
    : ready || status === "ingesting"
      ? "succeeded"
      : status === "acquiring"
        ? "running"
        : "pending";
  const parse: WorkflowState = failed ? "failed" : ready ? "succeeded" : status === "ingesting" ? "running" : "pending";
  const evidence: WorkflowState = failed ? "failed" : reproduction ? "succeeded" : ready ? "running" : "pending";
  const repo: WorkflowState = failed ? "failed" : reproduction ? (blocked ? "blocked" : "succeeded") : "pending";
  const plan: WorkflowState = failed ? "failed" : reproduction ? (blocked ? "blocked" : "succeeded") : "pending";
  const configure: WorkflowState = failed
    ? "failed"
    : anyStepStarted
      ? anyStepFailed
        ? "running"
        : blocked
          ? "blocked"
          : "succeeded"
      : reproduction
        ? "running"
        : "pending";
  const execute: WorkflowState = failed
    ? "failed"
    : completed
      ? "succeeded"
      : runningRepro
        ? anyStepFailed
          ? "failed"
          : "running"
        : blocked
          ? "blocked"
          : "pending";
  const verify: WorkflowState = failed
    ? "failed"
    : completed
      ? "succeeded"
      : reproPhase === "verifying"
        ? "running"
        : blocked
          ? "blocked"
          : "pending";
  return [
    { id: "acquire", label: "论文获取", state: acquire },
    { id: "parse", label: "内容解析", state: parse },
    { id: "evidence", label: "证据检索", state: evidence },
    { id: "repo", label: "仓库核验", state: repo },
    { id: "plan", label: "复现规划", state: plan },
    { id: "configure", label: "命令配置", state: configure },
    { id: "execute", label: "受控执行", state: execute },
    { id: "verify", label: "结果验收", state: verify },
  ];
}

export interface EvidenceRow {
  page: number;
  chunkId: string;
  score: number;
  text: string;
}

/** Parse research_search_evidence hits out of a tool result text. */
export function mapEvidenceFromResult(resultText: string): EvidenceRow[] {
  if (!resultText) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultText);
  } catch {
    return [];
  }
  const record = asRecord(parsed);
  const list = record?.hits;
  if (!Array.isArray(list)) return [];
  const rows: EvidenceRow[] = [];
  for (const item of list) {
    const hit = asRecord(item);
    if (!hit) continue;
    const page = typeof hit.page === "number" ? hit.page : -1;
    const chunkId = typeof hit.chunkId === "string" ? hit.chunkId : "";
    const text = typeof hit.text === "string" ? hit.text : "";
    if (page < 1 || !chunkId || !text) continue;
    const score = typeof hit.score === "number" ? hit.score : 0;
    rows.push({ page, chunkId, score, text });
  }
  return rows;
}
