import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { GroundedAnswerSchema } from "./answer-schema.ts";
import type { ResearchProjectService } from "./project-service.ts";

type ResearchToolService = Pick<ResearchProjectService, "findByWorkspace" | "searchEvidence" | "verifyAnswer">;

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
        const hits = await service.searchEvidence(project.projectId, input.query, input.limit);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ projectId: project.projectId, hits }) }],
          details: { hits },
        };
      },
    }),
    defineTool({
      name: "research_finalize_answer",
      label: "verify cited paper answer",
      description:
        "Validate the final answer against the current paper. Do not present a factual paper answer unless this tool returns accepted=true.",
      parameters: GroundedAnswerSchema,
      executionMode: "sequential",
      async execute(_toolCallId, input) {
        const verification = service.verifyAnswer(project.projectId, input);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ projectId: project.projectId, ...verification }) }],
          details: verification,
        };
      },
    }),
  ];
}
