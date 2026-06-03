/**
 * Pure, offline plan builder for the research reproduction workflow. It never
 * touches the network or the filesystem: repository adoption, extraction and
 * the step template are all deterministic functions of the input.
 */
import type { RepositoryCandidate } from "../../../../mcp/research-acquisition/types.ts";
import type { PaperChunk } from "../../../shared/research/types.ts";
import {
  MAX_EXTRACTION_ITEMS,
  MAX_REPRODUCTION_TITLE_CHARS,
  MAX_STEPS,
  type ReproductionExtraction,
  type ReproductionPlan,
  type ReproductionRepository,
  type ReproductionStep,
  type ReproductionStepKind,
} from "./types.ts";

const MAX_STEP_COMMAND_CHARS = 1000;
const MAX_EXTRACTED_REPOSITORY_URL_CHARS = 300;
const MAX_TRAINING_HINT_CHARS = 200;
const MAX_TRAINING_HINTS = 5;
const MAX_DATASET_TOKEN_CHARS = 100;
const DATASET_WINDOW_BEFORE = 40;
const DATASET_WINDOW_AFTER = 90;

const NO_REPOSITORY_NOTE = "未核验到官方仓库,按 Agent 最小复现执行(不冒充官方)";

export interface PlanInput {
  projectId: string;
  title: string;
  chunks: PaperChunk[];
  repository?: RepositoryCandidate | null;
  now?: () => Date;
}

export interface PlanResult {
  plan: ReproductionPlan;
  notes: string[];
}

// Extraction patterns are instantiated inside every function call so the
// global "lastIndex" state of /g regexes can never leak between calls.
const TRAINING_HINT_PATTERN = /learning rate|lr\s*=|batch size|epochs?|weight decay|\bAdam\b|\bSGD\b/i;

const METRIC_ALIASES: Record<string, string> = {
  psnr: "PSNR",
  ssim: "SSIM",
  lpips: "LPIPS",
  fid: "FID",
  accuracy: "accuracy",
  acc: "Acc",
  iou: "IoU",
  map: "mAP",
};

/** Metric acronyms that must never be captured as dataset names. */
const DATASET_EXCLUSIONS = new Set(["PSNR", "SSIM", "LPIPS", "FID", "MSE", "MAE", "NIQE", "KID"]);

function boundText(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

/**
 * Adopt the candidate repository only when it is trustworthy (an https URL
 * plus a non-empty match basis). Otherwise fall back to an agent
 * reproduction and record an explicit note so nobody mistakes the run for
 * the official one.
 */
function adoptRepository(
  repository: RepositoryCandidate | null | undefined,
  notes: string[],
): ReproductionRepository | null {
  if (repository !== null && repository !== undefined) {
    const matchBasis = repository.matchBasis.trim();
    if (repository.url.startsWith("https://") && matchBasis.length > 0) {
      return {
        url: repository.url,
        commitSha: repository.commitSha,
        license: repository.license,
        matchBasis,
      };
    }
  }
  notes.push(NO_REPOSITORY_NOTE);
  return null;
}

/** First https repository URL (github/gitlab/bitbucket) in the paper chunks. */
function extractRepositoryUrl(text: string): string | null {
  const pattern = /https:\/\/(?:github\.com|gitlab\.com|bitbucket\.org)\/\S+/i;
  const match = pattern.exec(text);
  if (match === null) return null;
  const cleaned = match[0].replace(/[.,;:!?]+$/, "").replace(/[/]+$/, "");
  return cleaned.length === 0 ? null : boundText(cleaned, MAX_EXTRACTED_REPOSITORY_URL_CHARS);
}

/**
 * Deterministically collect dataset-like tokens near the words dataset /
 * benchmark: capitalized tokens that contain a digit (Set5, Urban100, DIV2K)
 * or all-caps acronyms (COCO), deduplicated in first-appearance order.
 */
function extractDatasets(text: string): string[] {
  const datasets: string[] = [];
  const seen = new Set<string>();
  const keywordPattern = /datasets?|benchmarks?/gi;
  const tokenPattern = /[A-Z][A-Za-z0-9]*/g;
  let keywordMatch: RegExpExecArray | null;
  while ((keywordMatch = keywordPattern.exec(text)) !== null) {
    const windowStart = Math.max(0, keywordMatch.index - DATASET_WINDOW_BEFORE);
    const windowEnd = Math.min(text.length, keywordMatch.index + keywordMatch[0].length + DATASET_WINDOW_AFTER);
    const windowText = text.slice(windowStart, windowEnd);
    let tokenMatch: RegExpExecArray | null;
    while ((tokenMatch = tokenPattern.exec(windowText)) !== null) {
      const candidate = tokenMatch[0];
      if (!isPlausibleDatasetToken(candidate)) continue;
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      datasets.push(boundText(candidate, MAX_DATASET_TOKEN_CHARS));
      if (datasets.length >= MAX_EXTRACTION_ITEMS) return datasets;
    }
  }
  return datasets;
}

function isPlausibleDatasetToken(token: string): boolean {
  const lower = token.toLowerCase();
  if (
    lower === "dataset" ||
    lower === "datasets" ||
    lower === "benchmark" ||
    lower === "benchmarks" ||
    DATASET_EXCLUSIONS.has(token)
  ) {
    return false;
  }
  const hasDigit = /[0-9]/.test(token);
  const isAllCapsAcronym = token === token.toUpperCase() && /[A-Z]{2,}/.test(token);
  return hasDigit || isAllCapsAcronym;
}

/** Collect metric vocabulary hits, deduplicated in first-appearance order. */
function extractMetrics(text: string): string[] {
  const hits: Array<{ index: number; label: string }> = [];
  const patterns = [/\b(?:accuracy|Acc|PSNR|SSIM|LPIPS|FID|IoU)\b/gi, /\b(?:mAP|MAP)\b/g];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const label = METRIC_ALIASES[match[0].toLowerCase()];
      if (label !== undefined) hits.push({ index: match.index, label });
    }
  }
  hits.sort((a, b) => a.index - b.index);
  const metrics: string[] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    if (seen.has(hit.label)) continue;
    seen.add(hit.label);
    metrics.push(hit.label);
    if (metrics.length >= MAX_EXTRACTION_ITEMS) break;
  }
  return metrics;
}

/** Keep the first five text lines that mention a training hyperparameter. */
function extractTrainingHints(text: string): string[] {
  const hints: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || !TRAINING_HINT_PATTERN.test(line)) continue;
    const clipped = boundText(line, MAX_TRAINING_HINT_CHARS);
    if (!hints.includes(clipped)) hints.push(clipped);
    if (hints.length >= MAX_TRAINING_HINTS) break;
  }
  return hints;
}

interface StepTemplate {
  kind: ReproductionStepKind;
  title: string;
  description: string;
  command: string | null;
}

function firstStepTemplate(repository: ReproductionRepository | null): StepTemplate {
  if (repository !== null) {
    return {
      kind: "repository",
      title: "Clone official repository",
      description: "Fetch the matched official repository into the workspace",
      command: boundText(`git clone --depth 1 ${repository.url} workspace/`, MAX_STEP_COMMAND_CHARS),
    };
  }
  return {
    kind: "custom",
    title: "Scaffold agent reproduction module",
    description: "Create a minimal runnable module without claiming an official implementation",
    command: null,
  };
}

function buildSteps(repository: ReproductionRepository | null): ReproductionStep[] {
  const templates: StepTemplate[] = [
    firstStepTemplate(repository),
    {
      kind: "env",
      title: "Install dependencies",
      description: "Provision the runtime and package dependencies needed by the run",
      command: null,
    },
    {
      kind: "data",
      title: "Acquire dataset/weights",
      description: "Obtain the datasets and pretrained weights the paper references",
      command: null,
    },
    {
      kind: "train",
      title: "Run training/finetune",
      description: "Run training or finetuning at a feasible scale",
      command: null,
    },
    {
      kind: "evaluate",
      title: "Run evaluation and record metrics",
      description: "Evaluate the produced artifacts and record the reported metrics",
      command: null,
    },
    {
      kind: "report",
      title: "Write reproduction report",
      description: "Summarize environment, steps, metrics and deviations in the final report",
      command: null,
    },
  ];
  return templates.slice(0, MAX_STEPS).map((template, index) => ({
    id: `step-${index + 1}`,
    kind: template.kind,
    title: template.title,
    description: template.description,
    command: template.command,
    status: "pending",
    exitCode: null,
    artifactRef: null,
    error: null,
  }));
}

/**
 * Build a planned reproduction plan for a paper project. Pure and offline:
 * repository adoption plus extraction heuristics, no side effects.
 */
export function createReproductionPlan(input: PlanInput): PlanResult {
  const notes: string[] = [];
  const repository = adoptRepository(input.repository, notes);
  const chunksText = input.chunks.map((chunk) => chunk.text).join("\n");
  const extraction: ReproductionExtraction = {
    repositoryUrl: extractRepositoryUrl(chunksText),
    datasets: extractDatasets(chunksText),
    metrics: extractMetrics(chunksText),
    trainingHints: extractTrainingHints(chunksText),
  };
  const createdAt = (input.now ?? (() => new Date()))().toISOString();
  const plan: ReproductionPlan = {
    projectId: input.projectId,
    createdAt,
    updatedAt: createdAt,
    phase: "planned",
    title: boundText(input.title.trim(), MAX_REPRODUCTION_TITLE_CHARS),
    repository,
    agentReproduction: repository === null,
    extraction,
    steps: buildSteps(repository),
    repairRoundsUsed: 0,
    error: null,
  };
  return { plan, notes };
}

export function stepById(plan: ReproductionPlan, id: string): ReproductionStep | undefined {
  return plan.steps.find((step) => step.id === id);
}

export function nextPendingStep(plan: ReproductionPlan): ReproductionStep | undefined {
  return plan.steps.find((step) => step.status === "pending");
}
