import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { GroundedAnswerSchema } from "./answer-schema.ts";
import type { ResearchProjectService } from "./project-service.ts";
import type { ResearchAcquisitionClient } from "./mcp-client.ts";
import {
  MAX_QUERY_LENGTH,
  MAX_REPOSITORY_RESULTS,
  MAX_SOURCE_RESULTS,
  MAX_TITLE_LENGTH,
  MAX_URL_OR_PATH_LENGTH,
} from "../../../mcp/research-acquisition/types.ts";

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
const MAX_TOOL_ERROR_CHARS = 500;

function acquisitionTextContent(value: unknown) {
  return [{ type: "text" as const, text: JSON.stringify(value) }];
}

function redactLocalPaths(message: string, sensitivePaths: readonly string[]): string {
  let text = message;
  for (const sensitivePath of sensitivePaths) {
    if (sensitivePath) text = text.split(sensitivePath).join("[redacted]");
  }
  return text;
}

/** Turn a client failure into a bounded, path-redacted tool error result. */
function acquisitionToolError(toolName: string, error: unknown, sensitivePaths: readonly string[]) {
  const raw = error instanceof Error && error.message ? error.message : String(error);
  const redacted = redactLocalPaths(raw, sensitivePaths);
  const bounded =
    redacted.length <= MAX_TOOL_ERROR_CHARS ? redacted : redacted.slice(0, MAX_TOOL_ERROR_CHARS - 3) + "...";
  return { content: acquisitionTextContent({ error: bounded }), details: { error: bounded } };
}

export interface ResearchAcquisitionToolDependencies {
  client: ResearchAcquisitionClient;
  /** Fixed managed directory paper downloads are written into. */
  downloadsRoot: string;
}

const searchPapersParameters = Type.Object(
  {
    query: Type.String({ minLength: 1, maxLength: MAX_QUERY_LENGTH }),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SOURCE_RESULTS })),
  },
  { additionalProperties: false },
);

const downloadPaperParameters = Type.Object(
  {
    url: Type.String({ minLength: 1, maxLength: MAX_URL_OR_PATH_LENGTH }),
  },
  { additionalProperties: false },
);

const searchRepositoriesParameters = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: MAX_TITLE_LENGTH }),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_REPOSITORY_RESULTS })),
  },
  { additionalProperties: false },
);

/**
 * Pi tools that proxy the research-acquisition MCP service. The tools are only
 * created when the caller supplies a client; they operate purely on
 * research-acquisition data and never give the model arbitrary disk write
 * access: research_download_paper always writes into deps.downloadsRoot and the
 * target directory is never a model-supplied argument.
 */
export function createResearchAcquisitionTools(
  cwd: string,
  deps: ResearchAcquisitionToolDependencies,
): ToolDefinition[] {
  const sensitivePaths = [cwd, deps.downloadsRoot];
  return [
    defineTool<typeof searchPapersParameters, unknown>({
      name: "research_search_papers",
      label: "search research papers",
      description:
        "Search open-access research papers (arXiv/OpenAlex) through the managed research-acquisition " +
        "service. Returns candidate papers with open PDF links. Operates only on research-acquisition " +
        "data and never grants arbitrary disk write access.",
      parameters: searchPapersParameters,
      executionMode: "sequential",
      async execute(_toolCallId, input) {
        try {
          const candidates = await deps.client.searchPapers(input.query, input.limit);
          return { content: acquisitionTextContent({ candidates }), details: { candidates } };
        } catch (error) {
          return acquisitionToolError("research_search_papers", error, sensitivePaths);
        }
      },
    }),
    defineTool<typeof downloadPaperParameters, unknown>({
      name: "research_download_paper",
      label: "download research paper PDF",
      description:
        "Download an open-access paper PDF through the managed research-acquisition service into the " +
        "fixed managed downloads directory. Returns the written path, sha256 and byte count. The target " +
        "directory is fixed by the host and cannot be chosen by the model; this tool never grants " +
        "arbitrary disk write access.",
      parameters: downloadPaperParameters,
      executionMode: "sequential",
      async execute(_toolCallId, input) {
        try {
          const result = await deps.client.downloadPaper(input.url, deps.downloadsRoot);
          const summary = { path: result.path, sha256: result.sha256, bytes: result.bytes };
          return { content: acquisitionTextContent(summary), details: summary };
        } catch (error) {
          return acquisitionToolError("research_download_paper", error, sensitivePaths);
        }
      },
    }),
    defineTool<typeof searchRepositoriesParameters, unknown>({
      name: "research_search_repositories",
      label: "search paper repositories",
      description:
        "Find GitHub repositories related to a paper title through the managed research-acquisition " +
        "service. Operates only on research-acquisition data and never grants arbitrary disk write access.",
      parameters: searchRepositoriesParameters,
      executionMode: "sequential",
      async execute(_toolCallId, input) {
        try {
          const repositories = await deps.client.searchRepositories(input.title, input.limit);
          return { content: acquisitionTextContent({ repositories }), details: { repositories } };
        } catch (error) {
          return acquisitionToolError("research_search_repositories", error, sensitivePaths);
        }
      },
    }),
  ];
}
