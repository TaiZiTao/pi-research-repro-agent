/**
 * Pi tools that drive the research reproduction workflow
 * (src/agent-host/research/reproduction).
 *
 * Four bounded, sequential tools let the agent plan a reproduction of the
 * current paper from its evidence chunks, run the plan's step commands inside
 * the isolated reproduction workspace, verify the run with bounded repair
 * rounds, and render the final report.
 *
 * The caller only creates these tools when the workspace-bound project is
 * ready, and supplies every dependency (evidence reader, reproduction store,
 * injectable command runner) so the tools stay offline and deterministic.
 */
import { readdir } from "node:fs/promises";
import path from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { RepositoryCandidate } from "../../../../mcp/research-acquisition/types.ts";
import type { PaperChunk, ResearchProject } from "../../../shared/research/types.ts";
import { DEFAULT_STEP_TIMEOUT_MS, ReproductionExecutor, resetFailedSteps, type RunCommand } from "./executor.ts";
import { reproductionPaths } from "./paths.ts";
import { createReproductionPlan, nextPendingStep } from "./planner.ts";
import { buildReproductionReport, renderReproductionMarkdown } from "./report.ts";
import type { ReproductionStore } from "./store.ts";
import type { ReproductionPlan, ReproductionStep } from "./types.ts";

/** Upper bound of a tool-level error message (characters). */
const MAX_TOOL_ERROR_CHARS = 500;
/** Upper bound of artifact names collected for a reproduction report. */
const MAX_ARTIFACT_NAMES = 100;
/** Upper bound of artifact directory nesting while collecting names. */
const MAX_ARTIFACT_DEPTH = 8;
/** https prefix required of any model-supplied official repository URL. */
const HTTPS_PREFIX = "https://";

export interface ReproductionToolDependencies {
  /** Ready project bound to the current workspace (readiness is caller-gated). */
  project: ResearchProject;
  /** Read the project's parsed evidence chunks (tests inject fixtures). */
  readChunks: (projectId: string) => Promise<PaperChunk[]>;
  /** SQLite store the reproduction plans are persisted in. */
  store: ReproductionStore;
  /** Injectable command runner used for every step command. */
  runCommand: RunCommand;
  now?: () => Date;
  /** Per-command timeout in milliseconds; defaults to the executor default. */
  timeoutMs?: number;
}

function textContent(value: unknown) {
  return [{ type: "text" as const, text: JSON.stringify(value) }];
}

/** Replace every occurrence of each sensitive path (native and portable). */
function redactLocalPaths(message: string, sensitivePaths: readonly string[]): string {
  let text = message;
  for (const sensitivePath of sensitivePaths) {
    if (!sensitivePath) continue;
    text = text.split(sensitivePath).join("[redacted]");
    const portable = sensitivePath.split(path.sep).join("/");
    if (portable !== sensitivePath) text = text.split(portable).join("[redacted]");
  }
  return text;
}

/** Turn a tool failure into a bounded, path-redacted error result. */
function reproductionToolError(error: unknown, sensitivePaths: readonly string[]) {
  const raw = error instanceof Error && error.message ? error.message : String(error);
  const redacted = redactLocalPaths(raw, sensitivePaths);
  const bounded =
    redacted.length <= MAX_TOOL_ERROR_CHARS ? redacted : redacted.slice(0, MAX_TOOL_ERROR_CHARS - 3) + "...";
  return { content: textContent({ error: bounded }), details: { error: bounded } };
}

/** Run the tool body and shape both success and failure like the Pi tools. */
async function runReproductionTool(
  sensitivePaths: readonly string[],
  work: () => Promise<unknown>,
): Promise<{ content: ReturnType<typeof textContent>; details: unknown }> {
  try {
    const payload = await work();
    return { content: textContent(payload), details: payload };
  } catch (error) {
    return reproductionToolError(error, sensitivePaths);
  }
}

/**
 * Collect artifact file names (relative to the artifacts root, portable
 * separators) recursively. Read failures and missing roots yield an empty
 * list; the count and nesting depth are bounded.
 */
async function collectArtifactNames(artifactsRoot: string): Promise<string[]> {
  const names: string[] = [];
  async function walk(relative: string, depth: number): Promise<void> {
    if (names.length >= MAX_ARTIFACT_NAMES || depth > MAX_ARTIFACT_DEPTH) return;
    let entries;
    try {
      entries = await readdir(path.join(artifactsRoot, relative), { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      if (names.length >= MAX_ARTIFACT_NAMES) return;
      const entryRelative = relative.length === 0 ? entry.name : path.join(relative, entry.name);
      if (entry.isDirectory()) {
        await walk(entryRelative, depth + 1);
      } else if (entry.isFile()) {
        names.push(entryRelative.split(path.sep).join("/"));
      }
    }
  }
  await walk("", 0);
  return names;
}

/** Trimmed step view returned to the model; every field is bounded. */
function stepView(step: ReproductionStep) {
  return {
    id: step.id,
    title: step.title,
    status: step.status,
    exitCode: step.exitCode,
    artifactRef: step.artifactRef,
    error: step.error,
  };
}

/** First step whose status changed between the before/after plans. */
function stepThatRan(before: ReproductionPlan, after: ReproductionPlan): ReproductionStep | undefined {
  for (let index = 0; index < after.steps.length; index += 1) {
    if (after.steps[index].status !== before.steps[index]?.status) return after.steps[index];
  }
  return undefined;
}

/**
 * Build a RepositoryCandidate-shaped input from the bounded model arguments.
 * The planner only reads url/commitSha/license/matchBasis; the remaining
 * candidate fields are placeholders that the planner never inspects.
 */
function repositoryCandidate(input: {
  repositoryUrl: string;
  commitSha?: string;
  license?: string;
  matchBasis?: string;
}): RepositoryCandidate {
  return {
    name: "",
    fullName: "",
    url: input.repositoryUrl.trim(),
    description: null,
    license: input.license?.trim() || null,
    defaultBranch: null,
    commitSha: input.commitSha?.trim() || null,
    matchBasis: input.matchBasis?.trim() ?? "",
    stars: 0,
  };
}

const planParameters = Type.Object(
  {
    repositoryUrl: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
    commitSha: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    license: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    matchBasis: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  },
  { additionalProperties: false },
);

const executeParameters = Type.Object(
  {
    action: Type.Union([Type.Literal("begin-run"), Type.Literal("next-step")]),
  },
  { additionalProperties: false },
);

const verifyParameters = Type.Object(
  {
    accepted: Type.Boolean(),
    reason: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    repair: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

const reportParameters = Type.Object({}, { additionalProperties: false });

/**
 * Reproduction Pi tools for a ready paper project. Every result is bounded
 * (step views, plan summaries and markdown reports), parameter schemas reject
 * unknown keys, and execution is sequential so step commands never overlap.
 */
export function createReproductionTools(cwd: string, deps: ReproductionToolDependencies): ToolDefinition[] {
  const paths = reproductionPaths(deps.project.workspacePath);
  const sensitivePaths = [
    cwd,
    deps.project.workspacePath,
    paths.root,
    paths.workspace,
    paths.artifactsRoot,
    paths.stateFile,
  ];
  const readPlan = (): ReproductionPlan => {
    const plan = deps.store.get(deps.project.projectId);
    if (plan === undefined) {
      throw new Error("no reproduction plan for this project; call research_plan_reproduction first");
    }
    return plan;
  };
  const executor = () =>
    new ReproductionExecutor(deps.store, paths, {
      runCommand: deps.runCommand,
      now: deps.now,
      timeoutMs: deps.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS,
    });

  return [
    defineTool<typeof planParameters, unknown>({
      name: "research_plan_reproduction",
      label: "plan paper reproduction",
      description:
        "Create and persist a reproduction plan for the current paper from its evidence chunks. " +
        "Returns a bounded summary (planId, status, stepCount, agentReproduction, repository, notes); " +
        "the persisted plan holds the step template and extraction (datasets, metrics, training hints). " +
        "Provide repositoryUrl only for a verified official repository (https, with matchBasis and " +
        "optionally commitSha/license); otherwise the plan is an Agent 最小复现 and never claims to be official.",
      parameters: planParameters,
      executionMode: "sequential",
      async execute(_toolCallId, input) {
        return runReproductionTool(sensitivePaths, async () => {
          const chunks = await deps.readChunks(deps.project.projectId);
          const repository =
            input.repositoryUrl === undefined
              ? undefined
              : repositoryCandidate({
                  repositoryUrl: input.repositoryUrl,
                  commitSha: input.commitSha,
                  license: input.license,
                  matchBasis: input.matchBasis,
                });
          if (repository !== undefined && !repository.url.startsWith(HTTPS_PREFIX)) {
            throw new Error("InvalidParams: repositoryUrl must start with https:// when provided");
          }
          const { plan, notes } = createReproductionPlan({
            projectId: deps.project.projectId,
            title: deps.project.title,
            chunks,
            repository,
            now: deps.now,
          });
          deps.store.put(plan);
          return {
            planId: plan.projectId,
            status: plan.phase,
            stepCount: plan.steps.length,
            agentReproduction: plan.agentReproduction,
            repository: plan.repository,
            notes,
          };
        });
      },
    }),
    defineTool<typeof executeParameters, unknown>({
      name: "research_reproduction_execute",
      label: "execute reproduction step",
      description:
        "Drive the persisted reproduction run. action=begin-run starts it " +
        "(planned -> running) once. action=next-step executes the next pending step that has a command " +
        "inside the isolated reproduction workspace and reports ran / needs-agent / done with a bounded " +
        "step summary. Steps without a command stay pending (needs-agent) until the Agent handles them.",
      parameters: executeParameters,
      executionMode: "sequential",
      async execute(_toolCallId, input) {
        return runReproductionTool(sensitivePaths, async () => {
          const plan = readPlan();
          if (input.action === "begin-run") {
            const running = await executor().startRun(await executor().begin(plan));
            return { phase: running.phase, action: "ran" as const, step: undefined, error: running.error };
          }
          const outcome = await executor().executeNextStep(plan);
          const ranStep = outcome.action === "ran" ? stepThatRan(plan, outcome.plan) : undefined;
          const agentStep = outcome.action === "needs-agent" ? nextPendingStep(outcome.plan) : undefined;
          const viewedStep =
            ranStep !== undefined ? stepView(ranStep) : agentStep !== undefined ? stepView(agentStep) : undefined;
          return {
            phase: outcome.plan.phase,
            action: outcome.action,
            step: viewedStep,
            error: outcome.plan.error,
          };
        });
      },
    }),
    defineTool<typeof verifyParameters, unknown>({
      name: "research_reproduction_verify",
      label: "verify reproduction run",
      description:
        "Verify the running reproduction plan. accepted=true completes the plan when no step failed. " +
        "accepted=false with repair=true resets failed steps (running phase only) and starts another " +
        "repair round; at most 3 rounds are allowed before the plan stays blocked. reason is optional " +
        "and bounded. Returns phase, repairRoundsUsed and the bounded plan error.",
      parameters: verifyParameters,
      executionMode: "sequential",
      async execute(_toolCallId, input) {
        return runReproductionTool(sensitivePaths, async () => {
          const plan = readPlan();
          const repaired = input.repair === true && plan.phase === "running" ? resetFailedSteps(plan) : plan;
          const verified = await executor().verify(repaired, { accepted: input.accepted, reason: input.reason });
          return {
            phase: verified.phase,
            repairRoundsUsed: verified.repairRoundsUsed,
            error: verified.error,
          };
        });
      },
    }),
    defineTool<typeof reportParameters, unknown>({
      name: "research_reproduction_report",
      label: "render reproduction report",
      description:
        "Render a bounded markdown reproduction report (at most 20000 characters) for the persisted " +
        "plan: phase, repair rounds, source (official repository or Agent 最小复现), step table with " +
        "exit codes and failures, and the collected artifact names.",
      parameters: reportParameters,
      executionMode: "sequential",
      async execute(_toolCallId, _input) {
        return runReproductionTool(sensitivePaths, async () => {
          const plan = readPlan();
          const artifactNames = await collectArtifactNames(paths.artifactsRoot);
          const report = buildReproductionReport(plan, artifactNames, deps.now ?? (() => new Date()));
          const markdown = renderReproductionMarkdown(report);
          return { markdown };
        });
      },
    }),
  ];
}
