import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ResearchProjectService } from "./project-service.ts";

type ResearchToolService = Pick<ResearchProjectService, "findByWorkspace" | "searchEvidence">;

export function createResearchTools(cwd: string, service: ResearchToolService): ToolDefinition[] {
  const project = service.findByWorkspace(cwd);
  if (!project || project.status !== "ready") return [];

  return [
    defineTool({
      name: "research_search_evidence",
      label: "search paper evidence",
      description:
        "Search evidence in the current project only. Returns real page and chunk IDs that must be preserved when citing evidence.",
      parameters: Type.Object(
        {
          query: Type.String({ minLength: 1, maxLength: 1_000 }),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
        },
        { additionalProperties: false },
      ),
      executionMode: "sequential",
      async execute(_toolCallId, input) {
        const hits = service.searchEvidence(project.projectId, input.query, input.limit);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ projectId: project.projectId, hits }) }],
          details: { hits },
        };
      },
    }),
  ];
}
