/**
 * Shared types and size constants for the research-acquisition MCP server
 * (mcp/research-acquisition). Every output value is bounded so that MCP tool
 * results stay small and deterministic.
 */

/** A single paper candidate surfaced by an aggregate source search. */
export interface PaperCandidate {
  /** Stable per-source identifier, e.g. the arXiv ID or the OpenAlex work ID. */
  id: string;
  title: string;
  authors: string[];
  /** Publication year when the source reports one, otherwise null. */
  year: number | null;
  venue: string | null;
  /** Abstract text, truncated to MAX_ABSTRACT_CHARS, or null when unavailable. */
  abstract: string | null;
  /** Direct https URL to an open-access PDF, or null when unavailable. */
  pdfUrl: string | null;
  source: "arxiv" | "openalex";
  identifiers: {
    arxiv?: string;
    doi?: string;
    openalex?: string;
  };
}

/** A repository returned by the GitHub repository search tool. */
export interface RepositoryCandidate {
  name: string;
  fullName: string;
  url: string;
  description: string | null;
  license: string | null;
  defaultBranch: string | null;
  commitSha: string | null;
  /** Human-readable reason the repository matched, e.g. "title-keywords:...". */
  matchBasis: string;
  stars: number;
}

/** Result of a successfully downloaded open-access PDF. */
export interface DownloadResult {
  /** Absolute path of the file that was written. */
  path: string;
  /** Hex-encoded SHA-256 digest of the written bytes. */
  sha256: string;
  /** Number of bytes written. */
  bytes: number;
}

/** Structured reason a download request was rejected before writing bytes. */
export interface DownloadValidationError {
  reason: "protocol" | "filename" | "target";
  message: string;
}

/** Search query length bound shared by arXiv, OpenAlex and the MCP tool. */
export const MAX_QUERY_LENGTH = 200;
/** Title length bound for the GitHub repository search tool. */
export const MAX_TITLE_LENGTH = 300;
/** Length bound for URLs and target directory arguments. */
export const MAX_URL_OR_PATH_LENGTH = 2000;
/** Upper bound of results accepted from arXiv, OpenAlex and the aggregate. */
export const MAX_SOURCE_RESULTS = 20;
/** Default result count for paper searches. */
export const DEFAULT_SOURCE_LIMIT = 10;
/** Upper bound of results accepted from the GitHub repository search. */
export const MAX_REPOSITORY_RESULTS = 10;
/** Default result count for the GitHub repository search. */
export const DEFAULT_REPOSITORY_LIMIT = 5;
/** Per-candidate abstract cap (characters). */
export const MAX_ABSTRACT_CHARS = 2000;
/** Per-candidate author cap (entries). */
export const MAX_AUTHORS = 25;
/** Default per-file cap for PDF downloads (50 MiB). */
export const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
/** Bound applied to error message text before it crosses module boundaries. */
export const MAX_ERROR_MESSAGE_CHARS = 240;
/** Default network timeout for every upstream call made by a tool. */
export const DEFAULT_NETWORK_TIMEOUT_MS = 20_000;
