/**
 * Domain types and size constants for the research reproduction workflow
 * (src/agent-host/research/reproduction). Plans, steps and extractions are
 * bounded so they stay deterministic, small and safe to persist.
 */

/** Lifecycle phase of a reproduction plan. */
export type ReproductionPhase = "planned" | "preparing" | "running" | "verifying" | "completed" | "blocked";

/** Execution status of a single reproduction step. */
export type ReproductionStepStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";

/** Kind of work performed by a reproduction step. */
export type ReproductionStepKind = "repository" | "env" | "data" | "train" | "evaluate" | "report" | "custom";

export interface ReproductionStep {
  /** Stable ordered identifier, e.g. step-1, step-2. */
  id: string;
  kind: ReproductionStepKind;
  title: string;
  description: string;
  /** Shell command to run for this step, or null when the agent performs it. */
  command: string | null;
  status: ReproductionStepStatus;
  exitCode: number | null;
  /** Artifact path relative to the artifacts root, or null when none exists. */
  artifactRef: string | null;
  /** Size and digest captured when the artifact was written. */
  artifactBytes: number | null;
  artifactSha256: string | null;
  /** Bounded step error message, or null while the step has not failed. */
  error: string | null;
}

export interface ReproductionRepository {
  url: string;
  commitSha: string | null;
  license: string | null;
  /** Human-readable reason the repository was matched (e.g. title-keywords). */
  matchBasis: string;
}

export interface ReproductionExtraction {
  /** First repository URL found in the paper chunks, truncated, or null. */
  repositoryUrl: string | null;
  datasets: string[];
  metrics: string[];
  trainingHints: string[];
}

export interface ReproductionPlan {
  projectId: string;
  createdAt: string;
  updatedAt: string;
  phase: ReproductionPhase;
  /** Bounded reproduction title (<= MAX_REPRODUCTION_TITLE_CHARS). */
  title: string;
  /** null when no official repository was verified (agent reproduction). */
  repository: ReproductionRepository | null;
  /** True when the run must reproduce the paper without an official repo. */
  agentReproduction: boolean;
  extraction: ReproductionExtraction;
  steps: ReproductionStep[];
  repairRoundsUsed: number;
  error: string | null;
}

/** Upper bound of repair (verify -> run) cycles before a plan stays blocked. */
export const MAX_REPAIR_ROUNDS = 3;
/** Upper bound of a reproduction plan title (characters). */
export const MAX_REPRODUCTION_TITLE_CHARS = 300;
/** Upper bound of a reproduction plan error message (characters). */
export const MAX_REPRODUCTION_ERROR_CHARS = 500;
/** Upper bound of steps a reproduction plan may hold. */
export const MAX_STEPS = 20;
/** Upper bound of items inside any extraction collection (datasets, metrics). */
export const MAX_EXTRACTION_ITEMS = 10;
