import type { IngestionProgress } from "../../shared/research/types.ts";
import { ResearchProjectService, type ProjectServiceOptions } from "./project-service.ts";
import { ResearchProjectStore } from "./project-store.ts";
import path from "node:path";
import { resolveResearchRuntimePaths } from "./runtime-paths.ts";

export interface InitializeResearchRuntimeOptions {
  env?: NodeJS.ProcessEnv;
  runParser?: ProjectServiceOptions["runParser"];
  now?: ProjectServiceOptions["now"];
  emit?: (event: IngestionProgress) => void;
}

let researchStore: ResearchProjectStore | undefined;
let researchService: ResearchProjectService | undefined;

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
      emit: options.emit,
    });
    researchStore = store;
    researchService = service;
    return service;
  } catch (error) {
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

export function closeResearchRuntime(): void {
  const store = researchStore;
  researchService = undefined;
  researchStore = undefined;
  store?.close();
}

/**
 * Absolute downloads directory for research-acquisition paper downloads
 * (<userData>/research/downloads), or undefined when PI_DESKTOP_USER_DATA is
 * unset or not an absolute path.
 */
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
