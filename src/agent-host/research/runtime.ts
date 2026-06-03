import type { IngestionProgress } from "../../shared/research/types.ts";
import { ResearchProjectService, type ProjectServiceOptions } from "./project-service.ts";
import { ResearchProjectStore } from "./project-store.ts";
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
