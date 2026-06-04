/**
 * In-memory per-project event ledger backing research.detail recentEvents.
 *
 * Records are appended whenever the research runtime observes a notable
 * transition (PDF ingestion stages, reproduction plan lifecycle, step
 * status changes) and are retained for the lifetime of the runtime process
 * in a bounded ring per project, newest first on read.
 */

export interface ResearchEventLogEntry {
  type: string;
  stage?: string;
  message: string;
  createdAt: string;
}

const MAX_EVENTS_PER_PROJECT = 200;
const logs = new Map<string, ResearchEventLogEntry[]>();

export function recordResearchEvent(projectId: string, event: ResearchEventLogEntry): void {
  let bucket = logs.get(projectId);
  if (bucket === undefined) {
    bucket = [];
    logs.set(projectId, bucket);
  }
  bucket.push(event);
  if (bucket.length > MAX_EVENTS_PER_PROJECT) {
    bucket.splice(0, bucket.length - MAX_EVENTS_PER_PROJECT);
  }
}

/** Newest first; bounded by the caller-provided limit (default 100). */
export function listResearchEvents(projectId: string, limit = 100): ResearchEventLogEntry[] {
  const bucket = logs.get(projectId);
  if (bucket === undefined) return [];
  const start = Math.max(0, bucket.length - limit);
  return bucket.slice(start).reverse();
}

export function clearResearchEventLog(): void {
  logs.clear();
}

const PHASE_LABEL: Record<string, string> = {
  planned: "已规划",
  preparing: "准备",
  running: "执行中",
  verifying: "校验中",
  completed: "完成",
  blocked: "阻塞",
};

const STEP_LABEL: Record<string, string> = {
  pending: "待执行",
  running: "执行中",
  succeeded: "成功",
  failed: "失败",
  skipped: "跳过",
};

/**
 * Translate one reproduction plan store write into ledger events.
 *
 * Emits at most: a creation event for the first write, one event per phase
 * transition, one event per step whose status changed (pending states from
 * the initial write are skipped), and a final summary when the plan becomes
 * completed or blocked.
 */
export function recordReproductionPlanPut(
  projectId: string,
  previous: { phase: string; steps: Array<{ id: string; status: string }> } | undefined,
  next: {
    title: string;
    phase: string;
    repairRoundsUsed: number;
    error: string | null;
    steps: Array<{ id: string; title: string; status: string }>;
  },
  createdAt: string,
): void {
  const note = (stage: string, message: string): void => {
    recordResearchEvent(projectId, { type: "reproduction", stage, message, createdAt });
  };
  if (previous === undefined) {
    note(next.phase, `已创建复现计划:${next.title}`);
  } else if (previous.phase !== next.phase) {
    note(next.phase, `复现阶段 → ${PHASE_LABEL[next.phase] ?? next.phase}`);
  }
  const previousById = new Map(previous === undefined ? [] : previous.steps.map((step) => [step.id, step.status]));
  for (const step of next.steps) {
    if (previous !== undefined && previousById.get(step.id) === step.status) continue;
    if (step.status === "pending") continue;
    note(step.status, `${step.id} ${step.title} → ${STEP_LABEL[step.status] ?? step.status}`);
  }
  if (previous !== undefined && next.phase === "completed" && previous.phase !== "completed") {
    note("completed", `复现完成 · 修复轮次 ${next.repairRoundsUsed}`);
  } else if (previous !== undefined && next.phase === "blocked" && previous.phase !== "blocked") {
    const error = next.error ? `:${next.error.slice(0, 120)}` : "";
    note("blocked", `复现阻塞 · 修复轮次 ${next.repairRoundsUsed}${error}`);
  }
}
