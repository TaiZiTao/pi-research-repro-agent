/**
 * Execution guardrails and state driver for the research reproduction
 * workflow.
 *
 * This module is a guardrail plus audit layer, NOT a security sandbox: real
 * isolation comes from the reproduction workspace layout and the host
 * managed-process infrastructure. Its responsibilities are
 *
 *  - drive the planned -> preparing -> running -> verifying ->
 *    completed/blocked state machine with at most MAX_REPAIR_ROUNDS repair
 *    cycles,
 *  - block commands that are obviously destructive (see FORBIDDEN_COMMANDS),
 *  - run step commands inside the reproduction workspace with a bounded
 *    timeout and capture bounded output into artifacts/logs/<step>.log,
 *  - persist the plan through every transition so a crashed run can resume:
 *    succeeded steps are never re-run (breakpoint resume), and failed steps
 *    are only re-run after an explicit repair round.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ReproductionPaths } from "./paths.ts";
import { nextPendingStep } from "./planner.ts";
import { assertReproductionTransition, canRepair, isTerminal } from "./state-machine.ts";
import { ReproductionStore } from "./store.ts";
import { MAX_REPRODUCTION_ERROR_CHARS, type ReproductionPlan, type ReproductionStep } from "./types.ts";

/** Default per-command timeout. */
export const DEFAULT_STEP_TIMEOUT_MS = 120_000;
/** Upper bound of a single step command (characters). */
export const MAX_COMMAND_CHARS = 1000;
/** Tail of combined stdout+stderr kept for a step run (characters). */
export const MAX_CAPTURED_OUTPUT_CHARS = 8_000;
/** Upper bound of a step log file on disk (bytes). */
export const MAX_STEP_LOG_BYTES = 200 * 1024;
/** Tail of stderr used for a bounded step failure message. */
const MAX_STEP_ERROR_CHARS = 500;
/** Underlying runner error detail kept in bounded messages. */
const MAX_RUNNER_ERROR_CHARS = 300;

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Injectable command runner (the real host wires this to a managed process). */
export type RunCommand = (command: string, options: { cwd: string; timeoutMs: number }) => Promise<CommandResult>;

interface ForbiddenCommand {
  label: string;
  pattern: RegExp;
}

/**
 * Commands that must never run, however tempting. The list is deliberately
 * small and conservative; anything not listed may still be harmful, which is
 * why the executor is not a sandbox and runs inside the disposable
 * reproduction workspace only.
 */
export const FORBIDDEN_COMMANDS: readonly ForbiddenCommand[] = [
  {
    label: "system power control",
    pattern: /(?:^|[;&|]\s*)\b(?:shutdown|reboot|halt|poweroff)\b/i,
  },
  {
    label: "filesystem formatting",
    pattern: /\bmkfs\b/i,
  },
  {
    label: "disk partitioning",
    pattern: /\b(?:fdisk|gdisk|sfdisk|parted)\b/i,
  },
  {
    label: "recursive delete of root/home/drive/star/quoted targets",
    pattern: /\brm\s+(?:-[a-zA-Z]*[rf][a-zA-Z]*\s+)+(?:\/|~|\$HOME|\*|"[^"]*"|[A-Za-z]:[\\/])/i,
  },
  {
    label: "windows recursive directory delete",
    pattern: /\b(?:rmdir|rd)\s+\/s\b/i,
  },
  {
    label: "powershell destructive remove of drive root or wildcard",
    pattern: /\bRemove-Item\b[^|;&\n]*?(?:[A-Za-z]:[\\/]|\*)/i,
  },
  {
    label: "windows recursive file delete against drive root or wildcard",
    pattern: /\b(?:del|erase)\s+[^|;&]*?(?:[A-Za-z]:[\\/]|\*)/i,
  },
  {
    label: "drive formatting",
    pattern: /\bformat\s+[A-Za-z]:/i,
  },
  {
    label: "raw device write",
    pattern: /\bdd\b[^|;&\n]*?\bof=(?:\/dev\/|\\\\.\\)/i,
  },
  {
    label: "remote script piped into a shell",
    pattern: /\b(?:curl|wget)\b[^|;&\n]*?\|\s*(?:sh|bash)\b/i,
  },
];

function bounded(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 3)) + "...";
}

/** Reject empty, oversized or forbidden commands with a bounded error. */
export function assertCommandAllowed(command: string): void {
  if (typeof command !== "string" || command.trim().length === 0) {
    throw new Error("step command must not be empty");
  }
  if (command.length > MAX_COMMAND_CHARS) {
    throw new Error("step command must not exceed " + MAX_COMMAND_CHARS + " characters");
  }
  for (const forbidden of FORBIDDEN_COMMANDS) {
    if (forbidden.pattern.test(command)) {
      throw new Error("command denied: " + forbidden.label);
    }
  }
}

/**
 * Run a command through the injected runner and return a bounded merged
 * output. Runner failures (timeout, spawn error) surface as bounded errors.
 */
export async function runCommandBounded(
  command: string,
  run: RunCommand,
  options: { cwd: string; timeoutMs: number },
): Promise<{ exitCode: number; output: string }> {
  let result: CommandResult;
  try {
    result = await run(command, { cwd: options.cwd, timeoutMs: options.timeoutMs });
  } catch (error) {
    const detail = error instanceof Error && error.message ? error.message : String(error);
    throw new Error("step command failed to start: " + bounded(detail, MAX_RUNNER_ERROR_CHARS));
  }
  const merged = [result.stdout, result.stderr].filter((part) => part.length > 0).join("\n");
  return { exitCode: result.exitCode, output: bounded(merged, MAX_CAPTURED_OUTPUT_CHARS) };
}

/** Write bounded step output to <artifactsRoot>/logs/<stepId>.log, idempotent. */
export async function writeStepLog(artifactsRoot: string, stepId: string, text: string): Promise<string> {
  const logsRoot = path.join(artifactsRoot, "logs");
  await mkdir(logsRoot, { recursive: true });
  const fileName = stepId + ".log";
  const fullPath = path.join(logsRoot, fileName);
  const boundedText = text.length <= MAX_STEP_LOG_BYTES ? text : text.slice(0, MAX_STEP_LOG_BYTES);
  await writeFile(fullPath, boundedText, "utf8");
  return path.relative(artifactsRoot, fullPath).split(path.sep).join("/");
}

function timestamp(now: () => Date): string {
  return now().toISOString();
}

/** Pure helper: reset every failed step back to pending (repair round). */
export function resetFailedSteps(plan: ReproductionPlan): ReproductionPlan {
  const steps = plan.steps.map((step) =>
    step.status === "failed"
      ? { ...step, status: "pending" as const, exitCode: null, artifactRef: null, error: null }
      : step,
  );
  return { ...plan, steps };
}

export interface ReproductionExecutorDeps {
  /** Injectable command runner used for every step with a command. */
  runCommand: RunCommand;
  now?: () => Date;
  /** Per-command timeout; defaults to DEFAULT_STEP_TIMEOUT_MS. */
  timeoutMs?: number;
}

export interface ExecuteNextStepOutcome {
  plan: ReproductionPlan;
  action: "ran" | "needs-agent" | "done";
}

/**
 * Persisting state driver for one reproduction plan. Every method asserts the
 * current phase, transitions through the shared state machine and persists the
 * plan to the store after each change so a run can always resume.
 */
export class ReproductionExecutor {
  readonly #store: ReproductionStore;
  readonly #paths: ReproductionPaths;
  readonly #deps: ReproductionExecutorDeps;

  constructor(store: ReproductionStore, paths: ReproductionPaths, deps: ReproductionExecutorDeps) {
    this.#store = store;
    this.#paths = paths;
    this.#deps = deps;
  }

  #now(): () => Date {
    return this.#deps.now ?? (() => new Date());
  }

  #timeoutMs(): number {
    return this.#deps.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  }

  #persist(plan: ReproductionPlan): ReproductionPlan {
    const updated = { ...plan, updatedAt: timestamp(this.#now()) };
    this.#store.put(updated);
    return updated;
  }

  /** planned -> preparing; creates the reproduction directories. */
  async begin(plan: ReproductionPlan): Promise<ReproductionPlan> {
    if (isTerminal(plan.phase)) throw new Error("reproduction plan is already terminal");
    assertReproductionTransition(plan.phase, "preparing");
    await mkdir(this.#paths.root, { recursive: true });
    await mkdir(this.#paths.workspace, { recursive: true });
    await mkdir(this.#paths.artifactsRoot, { recursive: true });
    return this.#persist({ ...plan, phase: "preparing" });
  }

  /** preparing -> running. */
  async startRun(plan: ReproductionPlan): Promise<ReproductionPlan> {
    if (isTerminal(plan.phase)) throw new Error("reproduction plan is already terminal");
    assertReproductionTransition(plan.phase, "running");
    return this.#persist({ ...plan, phase: "running" });
  }

  /**
   * Execute the next pending step that has a command. Succeeded steps are
   * skipped (breakpoint resume). A pending step without a command yields
   * action=needs-agent and is left untouched. Returns action=ran when a step
   * ran (success or failure recorded), or action=done when no step remains.
   */
  async executeNextStep(plan: ReproductionPlan): Promise<ExecuteNextStepOutcome> {
    // Executing a step is not itself a phase transition: repair cycles return
    // to running and simply execute the next pending step again.
    if (plan.phase !== "running") {
      throw new Error("reproduction plan must be running before steps can execute");
    }
    const pending = nextPendingStep(plan);
    if (pending === undefined) {
      return { plan: this.#persist(plan), action: "done" };
    }
    if (pending.command === null || pending.command.trim().length === 0) {
      return { plan: this.#persist(plan), action: "needs-agent" };
    }
    assertCommandAllowed(pending.command);
    // Narrowed after the needs-agent guard above; never null here.
    const command = pending.command;

    const runningStep: ReproductionStep = { ...pending, status: "running" };
    const marked = {
      ...plan,
      steps: plan.steps.map((step) => (step.id === pending.id ? runningStep : step)),
    };
    this.#persist(marked);

    const run = this.#deps.runCommand;
    const outcome = await runCommandBounded(command, run, {
      cwd: this.#paths.workspace,
      timeoutMs: this.#timeoutMs(),
    });
    const logRef = await writeStepLog(this.#paths.artifactsRoot, runningStep.id, outcome.output);

    const finished: ReproductionStep =
      outcome.exitCode === 0
        ? { ...runningStep, status: "succeeded", exitCode: 0, artifactRef: logRef }
        : {
            ...runningStep,
            status: "failed",
            exitCode: outcome.exitCode,
            artifactRef: logRef,
            error: bounded(
              "step " + runningStep.id + " failed with exit code " + outcome.exitCode + ": " + outcome.output,
              MAX_STEP_ERROR_CHARS,
            ),
          };
    const updated = {
      ...marked,
      steps: marked.steps.map((step) => (step.id === runningStep.id ? finished : step)),
    };
    return { plan: this.#persist(updated), action: "ran" };
  }

  /**
   * running -> verifying, then accept or start another repair round:
   *  - accepted with no failed step: verifying -> completed;
   *  - rejected while canRepair: repairRoundsUsed += 1, verifying -> running;
   *  - rejected past the round limit: verifying -> blocked.
   */
  async verify(plan: ReproductionPlan, options: { accepted: boolean; reason?: string }): Promise<ReproductionPlan> {
    if (isTerminal(plan.phase)) throw new Error("reproduction plan is already terminal");
    assertReproductionTransition(plan.phase, "verifying");
    const hasFailed = plan.steps.some((step) => step.status === "failed");
    const ok = options.accepted && !hasFailed;
    const reason = bounded((options.reason ?? "").trim(), MAX_REPRODUCTION_ERROR_CHARS);

    if (ok) {
      return this.#persist({ ...plan, phase: "completed", error: null });
    }
    // The plan is being verified; evaluate the round limit against the
    // verifying phase rather than the incoming running phase.
    if (canRepair("verifying", plan.repairRoundsUsed)) {
      const nextRound = plan.repairRoundsUsed + 1;
      const detail = "repair round " + nextRound + (reason.length > 0 ? ": " + reason : ": verification failed");
      return this.#persist({
        ...plan,
        phase: "running",
        repairRoundsUsed: nextRound,
        error: bounded(detail, MAX_REPRODUCTION_ERROR_CHARS),
      });
    }
    const detail = reason.length > 0 ? reason : "verification failed after " + plan.repairRoundsUsed + " repair rounds";
    return this.#persist({ ...plan, phase: "blocked", error: bounded(detail, MAX_REPRODUCTION_ERROR_CHARS) });
  }
}
