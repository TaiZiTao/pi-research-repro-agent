/**
 * MCP server exposing the research-acquisition tools: search_papers,
 * download_paper and search_repositories.
 *
 * The server is wired with dependency injection: createResearchAcquisitionServer
 * accepts overridable searchPapers/downloadPdf/searchRepositories
 * implementations plus network knobs (fetch function, timeout, GitHub token),
 * which keeps every integration test fully offline. Tool handlers only read
 * their arguments from the JSON-RPC request and never log tokens or keys.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { aggregateCandidates, ResearchSourceError } from "./paper-sources.ts";
import { DownloadError, downloadOpenPdf } from "./download.ts";
import type { DownloadResult, PaperCandidate, RepositoryCandidate } from "./types.ts";
import {
  DEFAULT_NETWORK_TIMEOUT_MS,
  DEFAULT_REPOSITORY_LIMIT,
  DEFAULT_SOURCE_LIMIT,
  MAX_ERROR_MESSAGE_CHARS,
  MAX_QUERY_LENGTH,
  MAX_REPOSITORY_RESULTS,
  MAX_SOURCE_RESULTS,
  MAX_TITLE_LENGTH,
  MAX_URL_OR_PATH_LENGTH,
} from "./types.ts";

const SERVER_NAME = "research-acquisition";
const SERVER_VERSION = "0.1.0";
const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_USER_AGENT = "pi-desktop-research/0.1.0 (research-acquisition)";
const MAX_GITHUB_RESPONSE_CHARS = 5 * 1024 * 1024;
const GITHUB_TOKEN_ENV = "RESEARCH_GITHUB_TOKEN";

interface ToolInputSchema {
  type: "object";
  properties: Record<string, object>;
  required: string[];
}

export interface ResearchAcquisitionToolDefinition {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
}

/** The three tools this server registers, with bounded descriptions/schemas. */
export const RESEARCH_ACQUISITION_TOOLS: readonly ResearchAcquisitionToolDefinition[] = [
  {
    name: "search_papers",
    description:
      "Search open-access research papers on arXiv and OpenAlex. Returns up to limit " +
      "candidates (title, authors, year, truncated abstract, identifiers, open PDF url).",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          minLength: 1,
          maxLength: MAX_QUERY_LENGTH,
          description: "Natural-language research query (1-200 characters).",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_SOURCE_RESULTS,
          description: "Maximum number of candidates to return (1-20, default 10).",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "download_paper",
    description:
      "Download an open-access PDF from an https URL into an absolute target " +
      "directory. Returns the written path, sha256 and byte count.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          minLength: 1,
          maxLength: MAX_URL_OR_PATH_LENGTH,
          description: "Absolute https URL of the open PDF.",
        },
        targetDir: {
          type: "string",
          minLength: 1,
          maxLength: MAX_URL_OR_PATH_LENGTH,
          description: "Absolute path of the directory the PDF should be written into.",
        },
      },
      required: ["url", "targetDir"],
    },
  },
  {
    name: "search_repositories",
    description:
      "Find GitHub repositories related to a paper title. Up to 10 repositories " +
      "are returned with description, license, default branch, head commit sha and stars.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          minLength: 1,
          maxLength: MAX_TITLE_LENGTH,
          description: "Paper title (1-300 characters) used to derive search keywords.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_REPOSITORY_RESULTS,
          description: "Maximum number of repositories to return (1-10, default 5).",
        },
      },
      required: ["title"],
    },
  },
];

export interface ResearchAcquisitionToolContext {
  fetchFn: typeof globalThis.fetch;
  signal: AbortSignal;
  /** Never logged; only added to GitHub requests when present. */
  githubToken: string | undefined;
}

export type SearchPapersImplementation = (
  query: string,
  limit: number,
  context: ResearchAcquisitionToolContext,
) => Promise<PaperCandidate[]>;

export type DownloadPdfImplementation = (
  url: string,
  targetDir: string,
  context: ResearchAcquisitionToolContext,
) => Promise<DownloadResult>;

export type SearchRepositoriesImplementation = (
  title: string,
  limit: number,
  context: ResearchAcquisitionToolContext,
) => Promise<RepositoryCandidate[]>;

export interface ResearchAcquisitionServerOptions {
  /** Injectable fetch implementation; defaults to globalThis.fetch. */
  fetchFn?: typeof globalThis.fetch;
  /** Per-tool-call network timeout in ms; defaults to 20 seconds. */
  timeoutMs?: number;
  /** GitHub token; falls back to the RESEARCH_GITHUB_TOKEN environment variable. */
  githubToken?: string;
  /** Override for the search_papers backend (used by tests as a stub). */
  searchPapers?: SearchPapersImplementation;
  /** Override for the download_paper backend (used by tests as a stub). */
  downloadPdf?: DownloadPdfImplementation;
  /** Override for the search_repositories backend (used by tests as a stub). */
  searchRepositories?: SearchRepositoriesImplementation;
}

function boundText(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 3)) + "...";
}

function failureText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

/** Bounded error for our own GitHub client calls (never contains the token). */
class UpstreamHttpError extends Error {
  constructor(message: string) {
    super(boundText(message, MAX_ERROR_MESSAGE_CHARS));
    this.name = "UpstreamHttpError";
  }
}

function invalidParams(toolName: string, detail: string): McpError {
  return new McpError(ErrorCode.InvalidParams, toolName + ": " + detail);
}

function requireTextArgument(args: Record<string, unknown>, toolName: string, key: string, maxLength: number): string {
  const raw = args[key];
  if (typeof raw !== "string") {
    throw invalidParams(toolName, '"' + key + '" must be a string');
  }
  if (raw.length === 0 || raw.length > maxLength) {
    throw invalidParams(toolName, '"' + key + '" must be between 1 and ' + maxLength + " characters");
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw invalidParams(toolName, '"' + key + '" must not be empty');
  }
  return trimmed;
}

function optionalIntegerArgument(
  args: Record<string, unknown>,
  toolName: string,
  key: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const raw = args[key];
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < minimum || raw > maximum) {
    throw invalidParams(toolName, '"' + key + '" must be an integer between ' + minimum + " and " + maximum);
  }
  return raw;
}

/**
 * Derive a GitHub search query from a paper title: the first five
 * alphanumeric words of at least four characters, URL-encoded and joined
 * with "+". Throws an InvalidParams error when no usable keyword exists.
 */
export function githubSearchQuery(title: string): string {
  const tokens = title.match(/[A-Za-z0-9]+/g) ?? [];
  const keywords = tokens.filter((token) => token.length >= 4).slice(0, 5);
  if (keywords.length === 0) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "search_repositories: title must contain at least one alphanumeric keyword of 4 or more characters",
    );
  }
  return keywords.map(encodeURIComponent).join("+");
}

async function fetchGitHubJson(
  url: string,
  headers: Record<string, string>,
  context: ResearchAcquisitionToolContext,
): Promise<unknown> {
  let response: Response;
  try {
    response = await context.fetchFn(url, { headers, signal: context.signal });
  } catch (error) {
    throw new UpstreamHttpError("github request failed: " + failureText(error));
  }
  if (!response.ok) {
    throw new UpstreamHttpError("github returned HTTP " + response.status);
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new UpstreamHttpError("github response could not be read");
  }
  if (text.length > MAX_GITHUB_RESPONSE_CHARS) {
    throw new UpstreamHttpError("github response exceeded size limit");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new UpstreamHttpError("github returned invalid JSON");
  }
}

/** Best-effort head commit sha lookup; every failure simply yields null. */
async function fetchHeadCommitSha(
  fullName: string,
  branch: string,
  headers: Record<string, string>,
  context: ResearchAcquisitionToolContext,
): Promise<string | null> {
  try {
    const segments = fullName.split("/");
    if (segments.length !== 2) {
      return null;
    }
    const encodedPath = segments.map(encodeURIComponent).join("/") + "/commits/" + encodeURIComponent(branch);
    const url = GITHUB_API_BASE + "/repos/" + encodedPath + "?per_page=1";
    const payload = await fetchGitHubJson(url, headers, context);
    if (Array.isArray(payload) && payload.length > 0) {
      const first = payload[0] as { sha?: unknown };
      return typeof first.sha === "string" ? first.sha : null;
    }
    return null;
  } catch {
    return null;
  }
}

function githubHeaders(context: ResearchAcquisitionToolContext): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": GITHUB_USER_AGENT,
  };
  if (context.githubToken !== undefined && context.githubToken.length > 0) {
    headers.authorization = "Bearer " + context.githubToken;
  }
  return headers;
}

interface GitHubRepositoryItem {
  name?: unknown;
  full_name?: unknown;
  html_url?: unknown;
  description?: unknown;
  default_branch?: unknown;
  stargazers_count?: unknown;
  license?: { spdx_id?: unknown } | null;
}

/**
 * Default search_repositories implementation: GitHub repository search keyed
 * on title keywords, with a best-effort head commit lookup per repository.
 * The GitHub token is only ever put into request headers, never into errors.
 */
async function searchGithubRepositories(
  title: string,
  limit: number,
  context: ResearchAcquisitionToolContext,
): Promise<RepositoryCandidate[]> {
  const query = githubSearchQuery(title);
  const headers = githubHeaders(context);
  const searchUrl = GITHUB_API_BASE + "/search/repositories?q=" + query + "&per_page=" + limit;
  const payload = await fetchGitHubJson(searchUrl, headers, context);
  if (payload === null || typeof payload !== "object") {
    throw new UpstreamHttpError("github search returned an unexpected response");
  }
  const container = payload as { items?: unknown };
  if (!Array.isArray(container.items)) {
    throw new UpstreamHttpError("github search returned an unexpected response");
  }

  const candidates: RepositoryCandidate[] = [];
  for (const raw of container.items.slice(0, limit)) {
    const item = raw as GitHubRepositoryItem | null;
    if (item === null || typeof item !== "object") {
      continue;
    }
    const fullName = typeof item.full_name === "string" ? item.full_name : null;
    const name = typeof item.name === "string" ? item.name : null;
    const url = typeof item.html_url === "string" ? item.html_url : null;
    if (fullName === null || name === null || url === null) {
      continue;
    }
    const description = typeof item.description === "string" ? boundText(item.description, 2000) : null;
    const defaultBranch = typeof item.default_branch === "string" ? item.default_branch : null;
    const license =
      item.license !== null && item.license !== undefined && typeof item.license === "object"
        ? typeof item.license.spdx_id === "string"
          ? item.license.spdx_id
          : null
        : null;
    const stars = typeof item.stargazers_count === "number" ? item.stargazers_count : 0;

    candidates.push({
      name,
      fullName,
      url,
      description,
      license,
      defaultBranch,
      commitSha: defaultBranch === null ? null : await fetchHeadCommitSha(fullName, defaultBranch, headers, context),
      matchBasis: "title-keywords:" + query,
      stars,
    });
  }
  return candidates;
}
/** Default search_papers implementation: aggregate arXiv + OpenAlex. */
async function searchPapersWithSources(
  query: string,
  limit: number,
  context: ResearchAcquisitionToolContext,
): Promise<PaperCandidate[]> {
  return aggregateCandidates(query, { limit, fetchFn: context.fetchFn, signal: context.signal });
}

/** Default download_paper implementation. */
async function downloadPdfToDirectory(
  url: string,
  targetDir: string,
  context: ResearchAcquisitionToolContext,
): Promise<DownloadResult> {
  return downloadOpenPdf(url, targetDir, { fetchFn: context.fetchFn, signal: context.signal });
}

interface ResolvedImplementations {
  searchPapers: SearchPapersImplementation;
  downloadPdf: DownloadPdfImplementation;
  searchRepositories: SearchRepositoriesImplementation;
}

function readGithubTokenFromEnvironment(): string | undefined {
  const token = process.env[GITHUB_TOKEN_ENV];
  if (typeof token !== "string" || token.trim().length === 0) {
    return undefined;
  }
  return token.trim();
}

type ToolExecutor = (
  args: Record<string, unknown>,
  impls: ResolvedImplementations,
  context: ResearchAcquisitionToolContext,
) => Promise<unknown>;

const TOOL_EXECUTORS: Record<string, ToolExecutor> = {
  search_papers: async (args, impls, context) => {
    const query = requireTextArgument(args, "search_papers", "query", MAX_QUERY_LENGTH);
    const limit =
      optionalIntegerArgument(args, "search_papers", "limit", 1, MAX_SOURCE_RESULTS) ?? DEFAULT_SOURCE_LIMIT;
    const candidates = await impls.searchPapers(query, limit, context);
    return { candidates };
  },
  download_paper: async (args, impls, context) => {
    const url = requireTextArgument(args, "download_paper", "url", MAX_URL_OR_PATH_LENGTH);
    const targetDir = requireTextArgument(args, "download_paper", "targetDir", MAX_URL_OR_PATH_LENGTH);
    if (!path.isAbsolute(targetDir)) {
      throw invalidParams(
        "download_paper",
        '"targetDir" must be an absolute path; which directories are writable is decided by higher-level policy',
      );
    }
    const result = await impls.downloadPdf(url, targetDir, context);
    return { path: result.path, sha256: result.sha256, bytes: result.bytes };
  },
  search_repositories: async (args, impls, context) => {
    const title = requireTextArgument(args, "search_repositories", "title", MAX_TITLE_LENGTH);
    const limit =
      optionalIntegerArgument(args, "search_repositories", "limit", 1, MAX_REPOSITORY_RESULTS) ??
      DEFAULT_REPOSITORY_LIMIT;
    // Pure keyword validation: rejects keyword-less titles before any network call.
    githubSearchQuery(title);
    const repositories = await impls.searchRepositories(title, limit, context);
    return { repositories };
  },
};
interface ToolCallContext {
  context: ResearchAcquisitionToolContext;
  dispose: () => void;
}

function createToolCallContext(
  fetchFn: typeof globalThis.fetch,
  githubToken: string | undefined,
  timeoutMs: number,
): ToolCallContext {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error("request timed out after " + timeoutMs + " ms"));
  }, timeoutMs);
  return {
    context: { fetchFn, signal: controller.signal, githubToken },
    dispose: () => {
      clearTimeout(timer);
    },
  };
}

/** Map any non-McpError failure to a bounded, token-free internal message. */
function safeDetail(error: unknown): string {
  if (
    error instanceof ResearchSourceError ||
    error instanceof DownloadError ||
    error instanceof UpstreamHttpError ||
    (error instanceof Error && error.name === "AbortError")
  ) {
    return boundText(error instanceof Error ? error.message : String(error), MAX_ERROR_MESSAGE_CHARS);
  }
  return "unexpected upstream error";
}

/**
 * Create the research-acquisition MCP server. Registering the three tools is
 * the only thing this function does; network behavior is fully replaceable
 * through options so tests never touch the real network.
 */
export function createResearchAcquisitionServer(options: ResearchAcquisitionServerOptions = {}): Server {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const timeoutMs =
    typeof options.timeoutMs === "number" && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_NETWORK_TIMEOUT_MS;
  const githubToken = options.githubToken ?? readGithubTokenFromEnvironment();

  const impls: ResolvedImplementations = {
    searchPapers: options.searchPapers ?? searchPapersWithSources,
    downloadPdf: options.downloadPdf ?? downloadPdfToDirectory,
    searchRepositories: options.searchRepositories ?? searchGithubRepositories,
  };

  const server = new Server({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: RESEARCH_ACQUISITION_TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const params = request.params;
    const toolName = params.name;
    const executor = TOOL_EXECUTORS[toolName];
    if (executor === undefined) {
      throw new McpError(ErrorCode.MethodNotFound, "unknown tool: " + toolName);
    }
    const args = (params.arguments === undefined ? {} : params.arguments) as Record<string, unknown>;
    const call = createToolCallContext(fetchFn, githubToken, timeoutMs);
    try {
      const result = await executor(args, impls, call.context);
      const text = JSON.stringify(result);
      return { content: [{ type: "text", text }] };
    } catch (error) {
      if (error instanceof McpError) {
        throw error;
      }
      throw new McpError(ErrorCode.InternalError, toolName + " failed: " + safeDetail(error));
    } finally {
      call.dispose();
    }
  });

  return server;
}

/**
 * Run the server over stdio. Called only when this module is executed as a
 * script (node mcp/research-acquisition/server.ts); importing the module for
 * tests never starts a transport.
 */
export async function main(): Promise<void> {
  const server = createResearchAcquisitionServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export default main;

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error("research-acquisition server error: " + (error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  });
}
