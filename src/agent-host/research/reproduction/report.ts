/**
 * Build and render bounded, offline reproduction reports from a plan.
 */
import type {
  ReproductionPhase,
  ReproductionPlan,
  ReproductionRepository,
  ReproductionStepKind,
  ReproductionStepStatus,
} from "./types.ts";

export interface ReproductionReport {
  projectId: string;
  title: string;
  agentReproduction: boolean;
  repository: ReproductionRepository | null;
  phase: ReproductionPhase;
  repairRoundsUsed: number;
  stepSummary: Array<{
    id: string;
    kind: ReproductionStepKind;
    title: string;
    status: ReproductionStepStatus;
    exitCode: number | null;
    artifactRef: string | null;
    error: string | null;
  }>;
  artifacts: string[];
  generatedAt: string;
}

/** The rendered markdown report must never exceed this many characters. */
const MAX_REPORT_CHARS = 20000;
const MAX_CELL_CHARS = 200;
const MAX_ARTIFACTS_LISTED = 100;
const MAX_ARTIFACT_CHARS = 300;

export function buildReproductionReport(
  plan: ReproductionPlan,
  artifactNames: string[],
  now: () => Date,
): ReproductionReport {
  return {
    projectId: plan.projectId,
    title: plan.title,
    agentReproduction: plan.agentReproduction,
    repository: plan.repository,
    phase: plan.phase,
    repairRoundsUsed: plan.repairRoundsUsed,
    stepSummary: plan.steps.map((step) => ({
      id: step.id,
      kind: step.kind,
      title: step.title,
      status: step.status,
      exitCode: step.exitCode,
      artifactRef: step.artifactRef,
      error: step.error,
    })),
    artifacts: artifactNames.slice(),
    generatedAt: now().toISOString(),
  };
}

/**
 * Render a report as bounded markdown. Table cells collapse newlines to
 * spaces and escape pipes so arbitrary step text cannot break the layout.
 */
export function renderReproductionMarkdown(report: ReproductionReport): string {
  const lines: string[] = [];
  const heading = report.agentReproduction ? `${report.title} (Agent 最小复现)` : report.title;
  lines.push(`# ${heading}`);
  lines.push("");
  lines.push(`- 阶段: ${report.phase}`);
  lines.push(`- 修复轮次: ${report.repairRoundsUsed}`);
  lines.push(`- 生成时间: ${report.generatedAt}`);
  lines.push("");
  lines.push("## 来源");
  lines.push("");
  if (report.repository === null) {
    lines.push("- 无官方仓库");
  } else {
    lines.push(`- 仓库: ${report.repository.url}`);
    lines.push(`- Commit: ${report.repository.commitSha ?? "-"}`);
    lines.push(`- License: ${report.repository.license ?? "-"}`);
    lines.push(`- 匹配依据: ${report.repository.matchBasis}`);
  }
  lines.push("");
  lines.push("## 步骤");
  lines.push("");
  lines.push("| ID | 类型 | 标题 | 状态 | 退出码 | 产物 | 错误 |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const step of report.stepSummary) {
    const row = [
      markdownCell(step.id),
      step.kind,
      markdownCell(step.title),
      step.status,
      step.exitCode === null ? "-" : String(step.exitCode),
      step.artifactRef === null ? "-" : markdownCell(step.artifactRef),
      step.error === null ? "-" : markdownCell(step.error),
    ];
    lines.push(`| ${row.join(" | ")} |`);
  }
  lines.push("");
  lines.push("## 产物");
  lines.push("");
  if (report.artifacts.length === 0) {
    lines.push("- 无");
  } else {
    for (const artifact of report.artifacts.slice(0, MAX_ARTIFACTS_LISTED)) {
      lines.push(`- ${markdownCell(artifact).slice(0, MAX_ARTIFACT_CHARS)}`);
    }
  }
  const markdown = lines.join("\n");
  return markdown.length <= MAX_REPORT_CHARS ? markdown : markdown.slice(0, MAX_REPORT_CHARS);
}

function markdownCell(value: string): string {
  const collapsed = value.replace(/[\r\n]+/g, " ").replace(/\|/g, "\\|");
  const bounded = collapsed.length > MAX_CELL_CHARS ? collapsed.slice(0, MAX_CELL_CHARS) : collapsed;
  return bounded.replace(/\\+$/, "").trim();
}
