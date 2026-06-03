/**
 * Client-side facade for the research-acquisition MCP service.
 *
 * This module wraps a remote or in-process MCP transport behind a small,
 * bounded and redactable service interface so the Pi agent layer never talks
 * JSON-RPC directly. Every error that crosses this boundary is a
 * ResearchAcquisitionClientError with a bounded, secret-free message.
 *
 * The transport is abstracted so tests can pair the official SDK Client with
 * createResearchAcquisitionServer over InMemoryTransport (fully offline), while
 * createStdioAcquisitionTransport provides the real sub-process transport used
 * by host wiring.
 */

import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createResearchAcquisitionServer } from "../../../mcp/research-acquisition/server.ts";
import type { DownloadResult, PaperCandidate, RepositoryCandidate } from "../../../mcp/research-acquisition/types.ts";
import {
  DEFAULT_NETWORK_TIMEOUT_MS,
  MAX_ERROR_MESSAGE_CHARS,
  MAX_QUERY_LENGTH,
  MAX_REPOSITORY_RESULTS,
  MAX_SOURCE_RESULTS,
  MAX_TITLE_LENGTH,
  MAX_URL_OR_PATH_LENGTH,
} from "../../../mcp/research-acquisition/types.ts";

const CLIENT_NAME = "pi-desktop-research-acquisition-client";
const CLIENT_VERSION = "0.1.0";

/**
 * Errors raised by the acquisition client. The message is bounded to
 * MAX_ERROR_MESSAGE_CHARS and every secret the caller registered is replaced
 * with "[redacted]" before the message is stored.
 */
export class ResearchAcquisitionClientError extends Error {
  constructor(message: string) {
    super(boundText(message, MAX_ERROR_MESSAGE_CHARS));
    this.name = "ResearchAcquisitionClientError";
  }
}

/**
 * Replace every non-empty registered secret of at least four characters with
 * "[redacted]". Short values are intentionally left alone so harmless tokens
 * such as "id" never trigger noisy rewriting.
 */
export function redactSecrets(message: string, secrets: readonly string[]): string {
  let redacted = message;
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 4) {
      redacted = redacted.split(secret).join("[redacted]");
    }
  }
  return redacted;
}

/** Minimal callTool payload accepted from host callers. */
export interface AcquisitionCallToolParams {
  name: string;
  arguments?: Record<string, unknown>;
}

/**
 * Narrow view of the official MCP SDK Client. Concrete SDK Client instances
 * are structurally compatible through the transport adapters below; results
 * are treated as unknown and narrowed defensively before parsing.
 */
export interface MCPClient {
  listTools(): Promise<unknown>;
  callTool(params: AcquisitionCallToolParams): Promise<unknown>;
  close(): Promise<void>;
}

/** An established client connection plus the means to release it. */
export interface AcquisitionConnection {
  client: MCPClient;
  close(): Promise<void>;
}

/** Transport abstraction: creating a connection is deferred until first use. */
export interface AcquisitionTransport {
  connect(): Promise<AcquisitionConnection>;
}

/** The research-acquisition service surface the Pi tools consume. */
export interface ResearchAcquisitionClient {
  searchPapers(query: string, limit?: number): Promise<PaperCandidate[]>;
  downloadPaper(url: string, targetDir: string): Promise<DownloadResult>;
  searchRepositories(title: string, limit?: number): Promise<RepositoryCandidate[]>;
  close(): Promise<void>;
}

export interface CreateResearchAcquisitionClientOptions {
  transport: AcquisitionTransport;
  /** Per-call timeout in ms; defaults to 20 seconds when unset or not positive. */
  timeoutMs?: number;
  /** Secrets to scrub from every error message (e.g. a GitHub token). */
  secrets?: readonly string[];
}

function boundText(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 3)) + "...";
}

/** Bounded client error carrying a redacted message for the given operation. */
function operationError(operation: string, error: unknown, secrets: readonly string[]): ResearchAcquisitionClientError {
  const raw = error instanceof Error && error.message ? error.message : String(error);
  const safe = redactSecrets(raw, secrets);
  return new ResearchAcquisitionClientError(`research-acquisition client: ${operation} failed: ${safe}`);
}

function requireArgumentString(value: unknown, toolName: string, key: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw new ResearchAcquisitionClientError(`${toolName}: "${key}" must be a string`);
  }
  if (value.length === 0 || value.length > maxLength) {
    throw new ResearchAcquisitionClientError(`${toolName}: "${key}" must be between 1 and ${maxLength} characters`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ResearchAcquisitionClientError(`${toolName}: "${key}" must not be empty`);
  }
  return trimmed;
}

function optionalLimitArgument(
  value: unknown,
  toolName: string,
  key: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new ResearchAcquisitionClientError(
      `${toolName}: "${key}" must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

/** Extract the first text block from an SDK tool result; anything else errors. */
function firstResultText(result: unknown, toolName: string): string {
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    throw new ResearchAcquisitionClientError(`${toolName}: expected an object tool result`);
  }
  const record = result as { isError?: unknown; content?: unknown };
  if (record.isError === true) {
    throw new ResearchAcquisitionClientError(`${toolName}: the server reported a tool error`);
  }
  if (!Array.isArray(record.content)) {
    throw new ResearchAcquisitionClientError(`${toolName}: expected a content array in the tool result`);
  }
  for (const entry of record.content) {
    if (entry !== null && typeof entry === "object") {
      const text = (entry as { text?: unknown }).text;
      if (typeof text === "string") {
        return text;
      }
    }
  }
  throw new ResearchAcquisitionClientError(`${toolName}: expected a text tool result`);
}

function parsePayload(text: string, toolName: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ResearchAcquisitionClientError(`${toolName}: tool returned invalid JSON`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ResearchAcquisitionClientError(`${toolName}: tool returned an unexpected payload`);
  }
  return parsed as Record<string, unknown>;
}

function parseListPayload(text: string, toolName: string, key: string): unknown[] {
  const payload = parsePayload(text, toolName);
  const list = payload[key];
  if (!Array.isArray(list)) {
    throw new ResearchAcquisitionClientError(`${toolName}: tool result is missing the "${key}" array`);
  }
  return list;
}

function parseDownloadPayload(text: string, toolName: string): DownloadResult {
  const payload = parsePayload(text, toolName);
  const resultPath = payload.path;
  const sha256 = payload.sha256;
  const bytes = payload.bytes;
  if (
    typeof resultPath !== "string" ||
    typeof sha256 !== "string" ||
    typeof bytes !== "number" ||
    !Number.isInteger(bytes) ||
    bytes < 0
  ) {
    throw new ResearchAcquisitionClientError(`${toolName}: tool result is missing a valid path/sha256/bytes`);
  }
  return { path: resultPath, sha256, bytes };
}

/**
 * Run a task under a client-side wall-clock timeout. The task keeps running in
 * the background after the race settles; its outcome is simply ignored.
 */
async function withClientTimeout<T>(timeoutMs: number, operation: string, task: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new ResearchAcquisitionClientError(
              `research-acquisition client: ${operation} timed out after ${timeoutMs} ms`,
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function absoluteTargetDirectory(value: string, toolName: string): string {
  if (value.length === 0 || value.length > MAX_URL_OR_PATH_LENGTH) {
    throw new ResearchAcquisitionClientError(
      `${toolName}: "targetDir" must be between 1 and ${MAX_URL_OR_PATH_LENGTH} characters`,
    );
  }
  if (!path.isAbsolute(value)) {
    throw new ResearchAcquisitionClientError(`${toolName}: "targetDir" must be an absolute path`);
  }
  return value;
}

/**
 * Create a research-acquisition client facade. The MCP connection is opened
 * lazily on the first tool call and reused afterwards; close() is idempotent.
 */
export function createResearchAcquisitionClient(
  options: CreateResearchAcquisitionClientOptions,
): Promise<ResearchAcquisitionClient> {
  const timeoutMs =
    typeof options.timeoutMs === "number" && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_NETWORK_TIMEOUT_MS;
  const secrets = options.secrets ?? [];
  let connection: AcquisitionConnection | undefined;
  let connecting: Promise<AcquisitionConnection> | undefined;
  let closed = false;

  function ensureConnection(): Promise<AcquisitionConnection> {
    if (closed) {
      return Promise.reject(new ResearchAcquisitionClientError("research-acquisition client is closed"));
    }
    if (connection) {
      return Promise.resolve(connection);
    }
    if (!connecting) {
      connecting = withClientTimeout(timeoutMs, "connect", () => options.transport.connect())
        .then((connected) => {
          if (closed) {
            void connected.close().catch(() => undefined);
            throw new ResearchAcquisitionClientError("research-acquisition client is closed");
          }
          connection = connected;
          return connected;
        })
        .catch((error) => {
          connecting = undefined;
          throw error;
        });
    }
    return connecting;
  }

  async function invokeTool(
    toolName: string,
    args: Record<string, unknown>,
    parse: (text: string) => unknown,
  ): Promise<unknown> {
    try {
      return await withClientTimeout(timeoutMs, toolName, async () => {
        const connected = await ensureConnection();
        const result = await connected.client.callTool({ name: toolName, arguments: args });
        return parse(firstResultText(result, toolName));
      });
    } catch (error) {
      if (error instanceof ResearchAcquisitionClientError) {
        throw error;
      }
      throw operationError(toolName, error, secrets);
    }
  }

  async function close(): Promise<void> {
    if (closed) {
      return;
    }
    closed = true;
    const current = connection;
    connection = undefined;
    connecting = undefined;
    if (current) {
      try {
        await current.close();
      } catch {
        // The connection is already released; close must stay idempotent.
      }
    }
  }

  return Promise.resolve({
    async searchPapers(query: string, limit?: number): Promise<PaperCandidate[]> {
      const safeQuery = requireArgumentString(query, "search_papers", "query", MAX_QUERY_LENGTH);
      const safeLimit = optionalLimitArgument(limit, "search_papers", "limit", 1, MAX_SOURCE_RESULTS);
      const args: Record<string, unknown> = { query: safeQuery };
      if (safeLimit !== undefined) {
        args.limit = safeLimit;
      }
      const parsed = await invokeTool("search_papers", args, (text) =>
        parseListPayload(text, "search_papers", "candidates"),
      );
      return parsed as PaperCandidate[];
    },
    async downloadPaper(url: string, targetDir: string): Promise<DownloadResult> {
      const safeUrl = requireArgumentString(url, "download_paper", "url", MAX_URL_OR_PATH_LENGTH);
      const safeTarget = absoluteTargetDirectory(targetDir, "download_paper");
      const parsed = await invokeTool("download_paper", { url: safeUrl, targetDir: safeTarget }, (text) =>
        parseDownloadPayload(text, "download_paper"),
      );
      return parsed as DownloadResult;
    },
    async searchRepositories(title: string, limit?: number): Promise<RepositoryCandidate[]> {
      const safeTitle = requireArgumentString(title, "search_repositories", "title", MAX_TITLE_LENGTH);
      const safeLimit = optionalLimitArgument(limit, "search_repositories", "limit", 1, MAX_REPOSITORY_RESULTS);
      const args: Record<string, unknown> = { title: safeTitle };
      if (safeLimit !== undefined) {
        args.limit = safeLimit;
      }
      const parsed = await invokeTool("search_repositories", args, (text) =>
        parseListPayload(text, "search_repositories", "repositories"),
      );
      return parsed as RepositoryCandidate[];
    },
    close,
  });
}

export interface StdioAcquisitionTransportOptions {
  /** Node executable used to launch the server; defaults to the current process executable. */
  nodeExecutable?: string;
  /** Absolute path to the research-acquisition server entry module. */
  serverPath: string;
}

/**
 * Real sub-process transport. The official StdioClientTransport owns the
 * spawned child: it launches `node <serverPath>` with piped stdio, and closing
 * the client ends stdin and then kills the process if it does not exit. No
 * network traffic happens at construction time; unit tests must not call this
 * transport (use the in-memory transport instead).
 */
export function createStdioAcquisitionTransport(options: StdioAcquisitionTransportOptions): AcquisitionTransport {
  return {
    async connect(): Promise<AcquisitionConnection> {
      const transport = new StdioClientTransport({
        command: options.nodeExecutable ?? process.execPath,
        args: [options.serverPath],
        stderr: "pipe",
      });
      const rawClient = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION });
      await rawClient.connect(transport);
      const client: MCPClient = {
        async listTools() {
          return rawClient.listTools();
        },
        async callTool(params) {
          return rawClient.callTool(params);
        },
        async close() {
          await rawClient.close();
        },
      };
      let closed = false;
      return {
        client,
        async close() {
          if (closed) {
            return;
          }
          closed = true;
          try {
            await rawClient.close();
          } catch {
            // The transport may already have been torn down.
          }
        },
      };
    },
  };
}

export interface InMemoryAcquisitionTransportOptions {
  /** Options forwarded to createResearchAcquisitionServer (used as stubs in tests). */
  serverOptions?: Parameters<typeof createResearchAcquisitionServer>[0];
}

/**
 * In-process transport for tests and demonstrations: pairs the real SDK Client
 * with createResearchAcquisitionServer over InMemoryTransport, following the
 * server-first connect order used by the offline server tests.
 */
export function createInMemoryAcquisitionTransport(
  options: InMemoryAcquisitionTransportOptions = {},
): AcquisitionTransport {
  return {
    async connect(): Promise<AcquisitionConnection> {
      const server = createResearchAcquisitionServer(options.serverOptions);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const rawClient = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION });
      await server.connect(serverTransport);
      await rawClient.connect(clientTransport);
      const client: MCPClient = {
        async listTools() {
          return rawClient.listTools();
        },
        async callTool(params) {
          return rawClient.callTool(params);
        },
        async close() {
          await rawClient.close();
        },
      };
      let closed = false;
      return {
        client,
        async close() {
          if (closed) {
            return;
          }
          closed = true;
          try {
            await rawClient.close();
          } catch {
            // Already closed.
          }
          try {
            await server.close();
          } catch {
            // Already closed.
          }
        },
      };
    },
  };
}
