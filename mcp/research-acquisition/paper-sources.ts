/**
 * Paper retrieval aggregation for the research-acquisition MCP server.
 *
 * Pure network layer: every function accepts an injected fetch function and an
 * optional abort signal, never touches the filesystem, and never talks to the
 * network unless a fetch function is supplied that does. All functions are
 * unit-tested offline with fixture responses.
 */

import type { PaperCandidate } from "./types.ts";
import {
  DEFAULT_SOURCE_LIMIT,
  MAX_ABSTRACT_CHARS,
  MAX_AUTHORS,
  MAX_ERROR_MESSAGE_CHARS,
  MAX_QUERY_LENGTH,
  MAX_SOURCE_RESULTS,
} from "./types.ts";

const ARXIV_API_URL = "https://export.arxiv.org/api/query";
const OPENALEX_API_URL = "https://api.openalex.org/works";
/** Raw response cap (bytes of XML/JSON text) per upstream request. */
const MAX_SOURCE_RESPONSE_BYTES = 4 * 1024 * 1024;

export type ResearchSourceName = "arxiv" | "openalex" | "aggregate";

/** Bounded error raised by the paper sources when a search cannot be satisfied. */
export class ResearchSourceError extends Error {
  readonly source: ResearchSourceName;

  constructor(source: ResearchSourceName, message: string) {
    super(boundText(message, MAX_ERROR_MESSAGE_CHARS));
    this.name = "ResearchSourceError";
    this.source = source;
  }
}

export interface SourceSearchOptions {
  /** Maximum number of results to request (1..MAX_SOURCE_RESULTS). */
  limit?: number;
  /** Injectable fetch implementation; defaults to globalThis.fetch. */
  fetchFn?: typeof globalThis.fetch;
  /** Optional abort signal forwarded to fetch. */
  signal?: AbortSignal;
}

export type AggregateSearchOptions = SourceSearchOptions;

function boundText(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 3)) + "...";
}

function failureMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

function assertQuery(query: string, source: ResearchSourceName): string {
  if (typeof query !== "string" || query.trim().length === 0) {
    throw new ResearchSourceError(source, "query must be a non-empty string");
  }
  if (query.trim().length > MAX_QUERY_LENGTH) {
    throw new ResearchSourceError(source, "query must not exceed " + MAX_QUERY_LENGTH + " characters");
  }
  return query.trim();
}

function assertLimit(limit: number | undefined, source: ResearchSourceName): number {
  if (limit === undefined) {
    return DEFAULT_SOURCE_LIMIT;
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SOURCE_RESULTS) {
    throw new ResearchSourceError(source, "limit must be an integer between 1 and " + MAX_SOURCE_RESULTS);
  }
  return limit;
}

/** Collapse whitespace and decode the common XML entities (in order). */
function decodeXml(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Extract the text between an opening and closing marker, or null. */
function between(raw: string, open: string, close: string): string | null {
  const start = raw.indexOf(open);
  if (start < 0) {
    return null;
  }
  const contentStart = start + open.length;
  const end = raw.indexOf(close, contentStart);
  if (end < 0) {
    return null;
  }
  const value = decodeXml(raw.slice(contentStart, end));
  return value.length === 0 ? null : value;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 3)) + "...";
}

/** Extract an arXiv id from a value such as "http://arxiv.org/abs/2401.12345v2". */
function arxivIdFromValue(value: string): string | null {
  const marker = "/abs/";
  const markerIndex = value.indexOf(marker);
  if (markerIndex >= 0) {
    const tail = value.slice(markerIndex + marker.length);
    const end = tail.search(/[\s?#<>\/]/);
    const id = end < 0 ? tail : tail.slice(0, end);
    return id.length > 0 ? id : null;
  }
  const bare = value.trim();
  return /^\d{4}\.\d{4,5}(v\d+)?$/i.test(bare) ? bare : null;
}

/** Extract a PDF href plus whether its rel attribute contains "related". */
function pdfLinkCandidate(tag: string): { href: string; related: boolean } | null {
  const typeMatch = /\btype\s*=\s*"([^"]*)"/.exec(tag);
  if (typeMatch === null || typeMatch[1].toLowerCase().indexOf("pdf") < 0) {
    return null;
  }
  const hrefMatch = /\bhref\s*=\s*"([^"]*)"/.exec(tag);
  if (hrefMatch === null || hrefMatch[1].length === 0) {
    return null;
  }
  const relMatch = /\brel\s*=\s*"([^"]*)"/.exec(tag);
  const related = relMatch !== null && relMatch[1].split(/\s+/).indexOf("related") >= 0;
  return { href: hrefMatch[1], related };
}

/** Scan <link ...> tags and return the PDF href, preferring rel="related". */
function findPdfHref(raw: string): string | null {
  let cursor = 0;
  let fallback: string | null = null;
  while (cursor < raw.length) {
    const start = raw.indexOf("<link", cursor);
    if (start < 0) {
      break;
    }
    const end = raw.indexOf(">", start);
    if (end < 0) {
      break;
    }
    const candidate = pdfLinkCandidate(raw.slice(start + 1, end));
    if (candidate !== null) {
      if (candidate.related) {
        return candidate.href;
      }
      fallback = candidate.href;
    }
    cursor = end + 1;
  }
  return fallback;
}

/** Collect text inside every <author> block of an entry. */
function findAuthors(raw: string, cap: number): string[] {
  const authors: string[] = [];
  let cursor = 0;
  while (authors.length < cap) {
    const start = raw.indexOf("<author>", cursor);
    if (start < 0) {
      break;
    }
    const end = raw.indexOf("</author>", start);
    if (end < 0) {
      break;
    }
    const name = between(raw.slice(start, end), "<name>", "</name>");
    if (name !== null) {
      authors.push(truncate(name, 200));
    }
    cursor = end + "</author>".length;
  }
  return authors;
}

/**
 * Parse an arXiv Atom feed into paper candidates. A body that does not look
 * like an Atom feed at all raises a bounded "invalid arxiv response" error; a
 * well-formed feed that simply has no entries yields an empty array.
 */
export function parseArxivFeed(xml: string): PaperCandidate[] {
  if (typeof xml !== "string" || xml.length === 0) {
    throw new ResearchSourceError("arxiv", "invalid arxiv response");
  }
  const startsWithProlog = xml.trimStart().startsWith("<?xml");
  if (!startsWithProlog && !xml.includes("<feed") && !xml.includes("<entry")) {
    throw new ResearchSourceError("arxiv", "invalid arxiv response");
  }

  const candidates: PaperCandidate[] = [];
  const openTag = "<entry>";
  const closeTag = "</entry>";
  let cursor = 0;
  while (true) {
    const openIndex = xml.indexOf(openTag, cursor);
    if (openIndex < 0) {
      break;
    }
    const contentStart = openIndex + openTag.length;
    const closeIndex = xml.indexOf(closeTag, contentStart);
    if (closeIndex < 0) {
      break;
    }
    const entry = xml.slice(openIndex, closeIndex + closeTag.length);
    cursor = closeIndex + closeTag.length;

    const rawId = between(entry, "<id>", "</id>");
    const arxivId = rawId === null ? null : arxivIdFromValue(rawId);
    const rawTitle = between(entry, "<title>", "</title>");
    if (arxivId === null || rawTitle === null) {
      continue;
    }

    const published = between(entry, "<published>", "</published>");
    const year = published === null ? null : Number.parseInt(published.slice(0, 4), 10);
    const summary = between(entry, "<summary>", "</summary>");
    const pdfUrl = findPdfHref(entry) ?? "https://arxiv.org/pdf/" + arxivId;

    candidates.push({
      id: arxivId,
      title: truncate(rawTitle, 600),
      authors: findAuthors(entry, MAX_AUTHORS),
      year: year === null || Number.isNaN(year) ? null : year,
      venue: null,
      abstract: summary === null ? null : truncate(summary, MAX_ABSTRACT_CHARS),
      pdfUrl,
      source: "arxiv",
      identifiers: { arxiv: arxivId },
    });
  }
  return candidates;
}

async function fetchResponseText(
  url: string,
  source: "arxiv" | "openalex",
  options: SourceSearchOptions,
  acceptHeader: string,
): Promise<string> {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchFn(url, { headers: { accept: acceptHeader }, signal: options.signal });
  } catch (error) {
    throw new ResearchSourceError(source, "request failed: " + failureMessage(error));
  }
  if (!response.ok) {
    throw new ResearchSourceError(source, "HTTP " + response.status + " from upstream");
  }
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throw new ResearchSourceError(source, "response could not be read: " + failureMessage(error));
  }
  if (text.length > MAX_SOURCE_RESPONSE_BYTES) {
    throw new ResearchSourceError(source, "upstream response exceeded size limit");
  }
  return text;
}

/**
 * Search arXiv for papers matching the query.
 * @throws ResearchSourceError for invalid query/limit arguments, transport
 *   failures or malformed responses.
 */
export async function searchArxiv(query: string, options: SourceSearchOptions = {}): Promise<PaperCandidate[]> {
  const cleanQuery = assertQuery(query, "arxiv");
  const limit = assertLimit(options.limit, "arxiv");
  const url =
    ARXIV_API_URL + "?search_query=" + encodeURIComponent("all:" + cleanQuery) + "&start=0&max_results=" + limit;
  const xml = await fetchResponseText(url, "arxiv", options, "application/atom+xml");
  return parseArxivFeed(xml);
}

/** Normalize a title for deduplication: lowercase, whitespace and punctuation removed. */
export function normalizeTitleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Strip a DOI URL prefix and lowercase it for deduplication. */
export function normalizeDoi(value: string): string {
  let doi = value.trim();
  const prefix = "https://doi.org/";
  const dxPrefix = "https://dx.doi.org/";
  if (doi.toLowerCase().startsWith(prefix)) {
    doi = doi.slice(prefix.length);
  } else if (doi.toLowerCase().startsWith(dxPrefix)) {
    doi = doi.slice(dxPrefix.length);
  }
  return doi;
}

interface OpenAlexWork {
  id?: unknown;
  title?: unknown;
  publication_year?: unknown;
  doi?: unknown;
  authorships?: Array<{ author?: { display_name?: unknown } | null } | null> | null;
  best_oa_location?: { pdf_url?: unknown } | null;
  open_access?: { is_oa?: unknown } | null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Extract the OpenAlex work id ("W...") from its canonical API URL. */
function openAlexWorkId(url: string): string | null {
  const trimmed = url.trim();
  const tail = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return tail.length > 0 ? tail : null;
}

/**
 * Parse an OpenAlex /works search response. Only records that are truly
 * open-access with a downloadable PDF (open_access.is_oa === true and
 * best_oa_location.pdf_url present) are accepted; every other record is
 * skipped by design.
 */
export function parseOpenAlexWorks(payload: unknown): PaperCandidate[] {
  const container = payload as { results?: unknown } | null;
  if (container === null || typeof container !== "object" || !Array.isArray(container.results)) {
    throw new ResearchSourceError("openalex", "invalid openalex response");
  }

  const candidates: PaperCandidate[] = [];
  for (const raw of container.results) {
    if (raw === null || typeof raw !== "object") {
      continue;
    }
    const work = raw as OpenAlexWork;
    const openAccess = work.open_access as { is_oa?: unknown } | null | undefined;
    if (openAccess?.is_oa !== true) {
      continue;
    }
    const location = work.best_oa_location as { pdf_url?: unknown } | null | undefined;
    const pdfUrl = optionalString(location?.pdf_url);
    if (pdfUrl === null) {
      continue;
    }
    const title = optionalString(work.title);
    const id = typeof work.id === "string" ? openAlexWorkId(work.id) : null;
    if (title === null || id === null) {
      continue;
    }

    const authors: string[] = [];
    if (Array.isArray(work.authorships)) {
      for (const authorship of work.authorships) {
        const name = optionalString(authorship?.author?.display_name);
        if (name !== null) {
          authors.push(truncate(name, 200));
        }
        if (authors.length >= MAX_AUTHORS) {
          break;
        }
      }
    }

    const doi = optionalString(work.doi);
    const rawYear = work.publication_year;
    const year = typeof rawYear === "number" && Number.isInteger(rawYear) ? rawYear : null;

    candidates.push({
      id,
      title: truncate(title, 600),
      authors,
      year,
      venue: null,
      abstract: null,
      pdfUrl,
      source: "openalex",
      identifiers: {
        doi: doi === null ? undefined : normalizeDoi(doi),
        openalex: id,
      },
    });
  }
  return candidates;
}

/**
 * Search OpenAlex for open-access works matching the query.
 * @throws ResearchSourceError for invalid query/limit arguments, transport
 *   failures or malformed responses.
 */
export async function searchOpenAlex(query: string, options: SourceSearchOptions = {}): Promise<PaperCandidate[]> {
  const cleanQuery = assertQuery(query, "openalex");
  const limit = assertLimit(options.limit, "openalex");
  const url = OPENALEX_API_URL + "?search=" + encodeURIComponent(cleanQuery) + "&per-page=" + limit;
  const text = await fetchResponseText(url, "openalex", options, "application/json");
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    throw new ResearchSourceError("openalex", "invalid openalex response");
  }
  return parseOpenAlexWorks(payload);
}

function candidateKeys(candidate: PaperCandidate): string[] {
  const keys: string[] = [];
  if (candidate.identifiers.arxiv !== undefined) {
    keys.push("arxiv:" + candidate.identifiers.arxiv.toLowerCase());
  }
  if (candidate.identifiers.doi !== undefined) {
    keys.push("doi:" + normalizeDoi(candidate.identifiers.doi).toLowerCase());
  }
  if (candidate.title.length > 0) {
    keys.push("title:" + normalizeTitleKey(candidate.title));
  }
  return keys;
}

function mergeAndSort(
  arxivResults: PaperCandidate[],
  openAlexResults: PaperCandidate[],
  cap: number,
): PaperCandidate[] {
  const seen = new Set<string>();
  const merged: PaperCandidate[] = [];
  for (const candidate of [...arxivResults, ...openAlexResults]) {
    const keys = candidateKeys(candidate);
    if (keys.some((key) => seen.has(key))) {
      continue;
    }
    for (const key of keys) {
      seen.add(key);
    }
    merged.push(candidate);
  }
  merged.sort(
    (left, right) =>
      (right.year ?? -1) - (left.year ?? -1) ||
      normalizeTitleKey(left.title).localeCompare(normalizeTitleKey(right.title)),
  );
  return merged.slice(0, cap);
}

/**
 * Aggregate paper candidates from arXiv and OpenAlex, deduplicating across
 * sources by arXiv id, DOI (case-insensitive) or normalized title. arXiv
 * entries win when an OpenAlex entry duplicates them; OpenAlex-only
 * duplicates keep the first occurrence. If one source fails but the other
 * succeeds the failed source contributes nothing; only when both fail is an
 * error raised. The returned array is sorted (newest first) and capped at
 * the requested limit.
 */
export async function aggregateCandidates(
  query: string,
  options: AggregateSearchOptions = {},
): Promise<PaperCandidate[]> {
  assertQuery(query, "aggregate");
  const limit = assertLimit(options.limit, "aggregate");
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const signal = options.signal;

  const settled = await Promise.allSettled([
    searchArxiv(query, { limit, fetchFn, signal }),
    searchOpenAlex(query, { limit, fetchFn, signal }),
  ]);
  const arxivResults = settled[0].status === "fulfilled" ? settled[0].value : [];
  const openAlexResults = settled[1].status === "fulfilled" ? settled[1].value : [];
  if (
    arxivResults.length === 0 &&
    openAlexResults.length === 0 &&
    settled.every((entry) => entry.status === "rejected")
  ) {
    const reasons = settled
      .map((entry) => (entry.status === "rejected" ? failureMessage(entry.reason) : ""))
      .filter((reason) => reason.length > 0)
      .join("; ");
    throw new ResearchSourceError("aggregate", "no results from any source: " + reasons);
  }
  return mergeAndSort(arxivResults, openAlexResults, limit);
}
