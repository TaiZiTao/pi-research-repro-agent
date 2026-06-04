import { exec } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { IngestionProgress, ResearchProject } from "../../shared/research/types.ts";
import type { ResearchAcquisitionClient } from "./mcp-client.ts";
import { createInMemoryAcquisitionTransport, createResearchAcquisitionClient } from "./mcp-client.ts";
import { ResearchProjectService, type ProjectServiceOptions } from "./project-service.ts";
import { ResearchProjectStore } from "./project-store.ts";
import type { RunCommand } from "./reproduction/executor.ts";
import { ReproductionStore } from "./reproduction/store.ts";
import type { ReproductionPlan } from "./reproduction/types.ts";
import { clearResearchEventLog, recordReproductionPlanPut, recordResearchEvent } from "./event-log.ts";
import { resolveResearchRuntimePaths } from "./runtime-paths.ts";
import { createResearchSessionTools } from "./session-tools.ts";

const execAsync = promisify(exec);
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

export interface InitializeResearchRuntimeOptions {
  env?: NodeJS.ProcessEnv;
  runParser?: ProjectServiceOptions["runParser"];
  now?: ProjectServiceOptions["now"];
  emit?: (event: IngestionProgress) => void;
}

let researchStore: ResearchProjectStore | undefined;
let researchService: ResearchProjectService | undefined;
let reproductionStore: ReproductionStore | undefined;
let acquisitionClient: ReturnType<typeof createResearchAcquisitionClient> | undefined;
let configuredResearchRoot: string | undefined;

const runResearchCommand: RunCommand = async (command, options) => {
  try {
    const result = await execAsync(command, {
      cwd: options.cwd,
      timeout: options.timeoutMs,
      maxBuffer: DEFAULT_MAX_OUTPUT_BYTES,
      windowsHide: true,
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as Error & { code?: unknown; stdout?: unknown; stderr?: unknown };
    if (typeof failure.code !== "number") throw error;
    return {
      exitCode: failure.code,
      stdout: typeof failure.stdout === "string" ? failure.stdout : "",
      stderr: typeof failure.stderr === "string" ? failure.stderr : failure.message,
    };
  }
};

export function initializeResearchRuntime(options: InitializeResearchRuntimeOptions = {}): ResearchProjectService {
  if (researchService) return researchService;
  const paths = resolveResearchRuntimePaths(options.env ?? process.env);
  const store = new ResearchProjectStore(paths.databasePath);
  try {
    const service = new ResearchProjectService(store, {
      researchRoot: paths.researchRoot,
      python: paths.python,
      workerPath: paths.workerPath,
      skillsSourceRoot: paths.skillsSourceRoot,
      runParser: options.runParser,
      now: options.now,
      emit: (progress) => {
        recordResearchEvent(progress.projectId, {
          type: "ingestion",
          stage: progress.stage,
          message: progress.message,
          createdAt: (options.now ?? (() => new Date()))().toISOString(),
        });
        options.emit?.(progress);
      },
    });
    const reproStore = new ReproductionStore(paths.databasePath, {
      onPut: (previous, next) =>
        recordReproductionPlanPut(next.projectId, previous, next, (options.now ?? (() => new Date()))().toISOString()),
    });
    const client = createResearchAcquisitionClient({
      transport: createInMemoryAcquisitionTransport(),
    });
    researchStore = store;
    researchService = service;
    reproductionStore = reproStore;
    acquisitionClient = client;
    configuredResearchRoot = paths.researchRoot;
    return service;
  } catch (error) {
    reproductionStore?.close();
    reproductionStore = undefined;
    store.close();
    throw error;
  }
}

export function peekResearchProjectService(): ResearchProjectService | undefined {
  return researchService;
}

export function getResearchProjectService(): ResearchProjectService {
  if (!researchService) throw new Error("Research runtime is unavailable");
  return researchService;
}

export function getResearchProjectById(projectId: string): ResearchProject | undefined {
  return researchStore?.get(projectId);
}

export function getReproductionPlanById(projectId: string): ReproductionPlan | undefined {
  return reproductionStore?.get(projectId);
}

export async function createResearchRuntimeTools(cwd: string) {
  if (!researchService || !reproductionStore || !acquisitionClient || !configuredResearchRoot) return [];
  const client = await acquisitionClient;
  return createResearchSessionTools(cwd, {
    projectService: researchService,
    acquisition: { client, downloadsRoot: path.join(configuredResearchRoot, "downloads") },
    reproduction: { store: reproductionStore, runCommand: runResearchCommand },
  });
}

export function closeResearchRuntime(): void {
  const store = researchStore;
  const reproStore = reproductionStore;
  const client = acquisitionClient;
  researchService = undefined;
  researchStore = undefined;
  reproductionStore = undefined;
  acquisitionClient = undefined;
  configuredResearchRoot = undefined;
  void client?.then((value) => value.close()).catch(() => undefined);
  reproStore?.close();
  store?.close();
  clearResearchEventLog();
}

/**
 * Absolute downloads directory for research-acquisition paper downloads
 * (<userData>/research/downloads), or undefined when PI_DESKTOP_USER_DATA is
 * unset or not an absolute path.
 */
/** Downloads root used by the runtime for acquisition downloads, or undefined pre-init. */
export function getResearchDownloadsRoot(): string | undefined {
  return configuredResearchRoot === undefined ? undefined : path.join(configuredResearchRoot, "downloads");
}

/** The shared acquisition client once the runtime is initialized. */
export async function getResearchAcquisitionClient(): Promise<ResearchAcquisitionClient | undefined> {
  return acquisitionClient === undefined ? undefined : acquisitionClient;
}

export function researchAcquisitionDownloadsRoot(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const userData = env.PI_DESKTOP_USER_DATA;
  if (typeof userData !== "string" || userData.trim().length === 0 || !path.isAbsolute(userData)) {
    return undefined;
  }
  return path.join(userData, "research", "downloads");
}

/** True when the research-acquisition downloads root can be resolved (graceful degradation otherwise). */
export function researchAcquisitionAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return researchAcquisitionDownloadsRoot(env) !== undefined;
}
