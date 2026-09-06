import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { PaperChunk, ResearchProject } from "../../shared/research/types.ts";
import type { ResearchAcquisitionClient } from "./mcp-client.ts";
import type { ResearchProjectService } from "./project-service.ts";
import type { RunCommand } from "./reproduction/executor.ts";
import { createReproductionTools } from "./reproduction/reproduction-tools.ts";
import type { ReproductionStore } from "./reproduction/store.ts";
import { createResearchAcquisitionTools, createResearchTools } from "./tools.ts";

type ProjectToolsService = Pick<
  ResearchProjectService,
  "findByWorkspace" | "searchEvidence" | "verifyAnswer" | "readChunks"
>;

export interface ResearchSessionToolDependencies {
  projectService: ProjectToolsService;
  acquisition?: {
    client: ResearchAcquisitionClient;
    downloadsRoot: string;
  };
  reproduction?: {
    store: ReproductionStore;
    runCommand: RunCommand;
  };
}

/** Assemble all research tools visible to one Agent session. */
export function createResearchSessionTools(cwd: string, deps: ResearchSessionToolDependencies): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  if (deps.acquisition) {
    tools.push(...createResearchAcquisitionTools(cwd, deps.acquisition));
  }
  tools.push(...createResearchTools(cwd, deps.projectService));

  const project: ResearchProject | undefined = deps.projectService.findByWorkspace(cwd);
  if (project?.status === "ready" && deps.reproduction) {
    tools.push(
      ...createReproductionTools(cwd, {
        project,
        readChunks: (projectId: string): Promise<PaperChunk[]> => deps.projectService.readChunks(projectId),
        store: deps.reproduction.store,
        runCommand: deps.reproduction.runCommand,
      }),
    );
  }
  return tools;
}
