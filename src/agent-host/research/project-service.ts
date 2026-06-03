import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  EvidenceHit,
  IngestionProgress,
  PaperChunk,
  ResearchProject,
  ResearchProjectStatus,
} from "../../shared/research/types.ts";
import { assertResearchTransition } from "../../shared/research/state-machine.ts";
import { searchEvidence } from "./evidence-search.ts";
import { inspectPdfInput, researchProjectPaths, type ResearchProjectPaths } from "./paths.ts";
import { ResearchProjectStore } from "./project-store.ts";
import { runPaperParser } from "./python-worker.ts";

const MAX_TITLE_CHARS = 200;
const MAX_ERROR_CHARS = 500;

export interface ImportPdfInput {
  sourcePath: string;
  title?: string;
}

export interface ProjectServiceOptions {
  researchRoot: string;
  python: string;
  workerPath: string;
  skillsSourceRoot: string;
  runParser?: typeof runPaperParser;
  now?: () => Date;
  emit?: (event: IngestionProgress) => void;
}

export class ResearchProjectNotFoundError extends Error {
  constructor(projectId: string) {
    super(`Research project not found: ${projectId}`);
    this.name = "ResearchProjectNotFoundError";
  }
}

export class ResearchProjectNotReadyError extends Error {
  constructor(projectId: string) {
    super(`Research project is not ready: ${projectId}`);
    this.name = "ResearchProjectNotReadyError";
  }
}

function titleFor(input: ImportPdfInput, sourceName: string): string {
  const provided = input.title?.trim();
  const title = provided || path.parse(sourceName).name.trim();
  return title.slice(0, MAX_TITLE_CHARS);
}

function transition(
  project: ResearchProject,
  status: ResearchProjectStatus,
  timestamp: string,
  changes: Partial<ResearchProject> = {},
): ResearchProject {
  assertResearchTransition(project.status, status);
  return { ...project, ...changes, status, updatedAt: timestamp };
}

function validateChunks(value: unknown, paperId: string): PaperChunk[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("invalid parser output: expected a nonempty JSON array");
  }

  const chunkIds = new Set<string>();
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error("invalid parser output: each chunk must be an object");
    }
    const record = item as Record<string, unknown>;
    if (record.paperId !== paperId) {
      throw new Error("invalid parser output: paperId does not match the managed PDF");
    }
    if (typeof record.chunkId !== "string" || record.chunkId.trim().length === 0) {
      throw new Error("invalid parser output: chunkId must be nonempty");
    }
    if (chunkIds.has(record.chunkId)) {
      throw new Error("invalid parser output: chunkId values must be unique");
    }
    chunkIds.add(record.chunkId);
    if (!Number.isInteger(record.page) || (record.page as number) <= 0) {
      throw new Error("invalid parser output: page must be a positive integer");
    }
    if (typeof record.text !== "string" || record.text.trim().length === 0 || record.text.length > 1200) {
      throw new Error("invalid parser output: text must contain 1 to 1200 characters");
    }
  }
  return value as PaperChunk[];
}

function redactError(error: unknown, sensitivePaths: string[]): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const sensitivePath of sensitivePaths) {
    if (sensitivePath) message = message.split(sensitivePath).join("[redacted]");
  }
  return `Paper import failed: ${message}`.slice(0, MAX_ERROR_CHARS);
}

async function writeMarkerAtomic(paths: ResearchProjectPaths, project: ResearchProject): Promise<void> {
  const temporary = path.join(paths.projectRoot, `.research-project-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(project, null, 2), "utf8");
    await rename(temporary, paths.projectFile);
  } finally {
    await rm(temporary, { force: true });
  }
}

export class ResearchProjectService {
  readonly #store: ResearchProjectStore;
  readonly #options: ProjectServiceOptions;

  constructor(store: ResearchProjectStore, options: ProjectServiceOptions) {
    this.#store = store;
    this.#options = options;
  }

  async importPdf(input: ImportPdfInput): Promise<ResearchProject> {
    const inspected = inspectPdfInput(input.sourcePath);
    const projectId = randomUUID();
    const runId = randomUUID();
    const paths = researchProjectPaths(this.#options.researchRoot, projectId);
    const now = () => (this.#options.now ?? (() => new Date()))().toISOString();
    const createdAt = now();
    let sequence = 0;
    let temporaryChunksPath = path.join(paths.evidenceRoot, `.chunks-${runId}.tmp`);

    await mkdir(paths.inputRoot, { recursive: true });
    await mkdir(paths.evidenceRoot, { recursive: true });
    await copyFile(inspected.canonicalPath, paths.managedPdfPath);
    const managedBytes = await readFile(paths.managedPdfPath);
    const sha256 = createHash("sha256").update(managedBytes).digest("hex");

    let project: ResearchProject = {
      projectId,
      title: titleFor(input, inspected.name),
      status: "created",
      workspacePath: paths.projectRoot,
      sourcePdfName: inspected.name,
      managedPdfPath: paths.managedPdfPath,
      sha256,
      pageCount: null,
      error: null,
      createdAt,
      updatedAt: createdAt,
    };

    const persist = async (): Promise<void> => {
      this.#store.put(project);
      await writeMarkerAtomic(paths, project);
    };
    const emit = (stage: IngestionProgress["stage"], message: string): void => {
      sequence += 1;
      this.#options.emit?.({ projectId, runId, sequence, stage, message });
    };

    try {
      project = transition(project, "acquiring", now());
      await persist();
      emit("copying", "Copied PDF into the managed research workspace");

      project = transition(project, "ingesting", now());
      await persist();
      emit("parsing", "Parsing PDF pages into evidence chunks");

      await (this.#options.runParser ?? runPaperParser)(
        this.#options.python,
        this.#options.workerPath,
        paths.managedPdfPath,
        temporaryChunksPath,
      );

      let chunks: PaperChunk[];
      try {
        chunks = validateChunks(JSON.parse(await readFile(temporaryChunksPath, "utf8")), sha256);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("invalid parser output:")) throw error;
        throw new Error(`invalid parser output: ${error instanceof Error ? error.message : String(error)}`);
      }

      emit("indexing", "Indexing validated evidence chunks");
      await rename(temporaryChunksPath, paths.chunksPath);
      temporaryChunksPath = "";

      const skillTarget = path.join(paths.skillsRoot, "paper_analysis", "SKILL.md");
      await mkdir(path.dirname(skillTarget), { recursive: true });
      await copyFile(path.join(this.#options.skillsSourceRoot, "paper_analysis", "SKILL.md"), skillTarget);

      const pageCount = Math.max(...chunks.map((chunk) => chunk.page));
      project = transition(project, "ready", now(), { pageCount, error: null });
      await persist();
      emit("complete", "Paper import is ready for evidence search");
      return project;
    } catch (error) {
      if (temporaryChunksPath) await rm(temporaryChunksPath, { force: true });
      if (project.status === "acquiring" || project.status === "ingesting") {
        project = transition(project, "failed", now(), {
          error: redactError(error, [inspected.canonicalPath, paths.projectRoot, paths.managedPdfPath]),
        });
        await persist();
        emit("failed", "Paper import failed");
        return project;
      }
      throw error;
    }
  }

  listProjects(): ResearchProject[] {
    return this.#store.list();
  }

  getProject(projectId: string): ResearchProject {
    const project = this.#store.get(projectId);
    if (project === undefined) throw new ResearchProjectNotFoundError(projectId);
    return project;
  }

  findByWorkspace(workspacePath: string): ResearchProject | undefined {
    const expected = path.resolve(workspacePath);
    const comparableExpected = process.platform === "win32" ? expected.toLowerCase() : expected;
    return this.#store.list().find((project) => {
      const candidate = path.resolve(project.workspacePath);
      return (process.platform === "win32" ? candidate.toLowerCase() : candidate) === comparableExpected;
    });
  }

  searchEvidence(projectId: string, query: string, limit?: number): EvidenceHit[] {
    const project = this.getProject(projectId);
    if (project.status !== "ready") throw new ResearchProjectNotReadyError(projectId);
    const chunksPath = researchProjectPaths(this.#options.researchRoot, projectId).chunksPath;
    if (!existsSync(chunksPath)) throw new Error(`Evidence chunks are missing for ready project: ${projectId}`);
    const chunks = validateChunks(JSON.parse(readFileSync(chunksPath, "utf8")), project.sha256);
    return searchEvidence(chunks, query, limit);
  }
}
