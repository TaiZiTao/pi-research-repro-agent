/**
 * Open-access PDF downloader for the research-acquisition MCP server.
 *
 * downloadOpenPdf only talks to https URLs, verifies that the served content
 * really is a PDF (by content-type and/or the PDF magic signature "%PDF-"),
 * streams the response to an explicit target directory and returns a bounded
 * result with the file path, SHA-256 digest and byte count. Every network
 * access goes through an injectable fetch function so the module can be
 * tested fully offline.
 */

import { createHash } from "node:crypto";
import { createWriteStream, mkdirSync, rmSync } from "node:fs";
import type { WriteStream } from "node:fs";
import path from "node:path";
import type { DownloadResult } from "./types.ts";
import { MAX_DOWNLOAD_BYTES, MAX_ERROR_MESSAGE_CHARS } from "./types.ts";

const PDF_MAGIC = "%PDF-";
const MAGIC_BYTES = 5;
const MAX_FILE_NAME_CHARS = 150;
const MAX_URL_OR_PATH_LENGTH = 2000;
const MAX_UNDERLYING_MESSAGE_CHARS = 160;

/** Bounded error raised when a PDF download request cannot be satisfied. */
export class DownloadError extends Error {
  constructor(message: string) {
    super(boundText(message, MAX_ERROR_MESSAGE_CHARS));
    this.name = "DownloadError";
  }
}

export interface DownloadPdfOptions {
  /** Injectable fetch implementation; defaults to globalThis.fetch. */
  fetchFn?: typeof globalThis.fetch;
  /** Optional abort signal forwarded to fetch. */
  signal?: AbortSignal;
  /** Byte cap enforced while streaming; defaults to MAX_DOWNLOAD_BYTES. */
  maxBytes?: number;
  /** Optional explicit file name. Must be a plain basename (no separators). */
  fileName?: string;
}

function boundText(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 3)) + "...";
}

function underlyingMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

/**
 * Derive a safe PDF file name from a URL or an arbitrary name: any directory
 * components are removed, characters outside [A-Za-z0-9._-] become dashes,
 * an empty result falls back to "paper.pdf" and the final name is truncated
 * to a bounded length while keeping a ".pdf" extension.
 */
export function safePdfFileName(urlOrName: string): string {
  let candidate = typeof urlOrName === "string" ? urlOrName : "";
  if (candidate.length === 0) {
    return "paper.pdf";
  }
  if (candidate.toLowerCase().startsWith("http://") || candidate.toLowerCase().startsWith("https://")) {
    try {
      candidate = new URL(candidate).pathname;
    } catch {
      candidate = urlOrName;
    }
  }
  // Normalize backslashes into slashes so directory components can be dropped.
  candidate = candidate.split("\\").join("/");
  const lastSlash = candidate.lastIndexOf("/");
  const base = lastSlash >= 0 ? candidate.slice(lastSlash + 1) : candidate;
  const slug = base
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");
  if (slug.length === 0) {
    return "paper.pdf";
  }
  let stem = slug;
  const hadPdfExtension = stem.toLowerCase().endsWith(".pdf");
  if (hadPdfExtension) {
    stem = stem.slice(0, stem.length - 4);
  }
  stem = stem.slice(0, 120);
  if (stem.length === 0) {
    return "paper.pdf";
  }
  return stem + ".pdf";
}
function resolveFileName(url: string, fileName: string | undefined): string {
  if (fileName === undefined) {
    return safePdfFileName(url);
  }
  if (typeof fileName !== "string" || fileName.length === 0 || fileName.length > MAX_FILE_NAME_CHARS) {
    throw new DownloadError("fileName must be a plain file name of at most " + MAX_FILE_NAME_CHARS + " characters");
  }
  const base = path.basename(fileName);
  if (base !== fileName || fileName === "." || fileName === "..") {
    throw new DownloadError("fileName must be a plain basename without path separators");
  }
  if (fileName.toLowerCase().endsWith(".pdf")) {
    return fileName;
  }
  return fileName + ".pdf";
}

function assertPdfUrl(url: string): void {
  if (typeof url !== "string" || url.length === 0 || url.length > MAX_URL_OR_PATH_LENGTH) {
    throw new DownloadError("url must be a string of at most " + MAX_URL_OR_PATH_LENGTH + " characters");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new DownloadError("url must be an absolute https URL");
  }
  if (parsed.protocol !== "https:") {
    throw new DownloadError("only https URLs are supported");
  }
}

function writeChunk(stream: WriteStream, chunk: Uint8Array): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    stream.write(chunk, (error: Error | null | undefined) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function toDownloadError(error: unknown): DownloadError {
  if (error instanceof DownloadError) {
    return error;
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new DownloadError("pdf download was aborted (timed out or cancelled)");
  }
  return new DownloadError("pdf download failed: " + boundText(underlyingMessage(error), MAX_UNDERLYING_MESSAGE_CHARS));
}

/**
 * Download an open-access PDF from url into targetDir.
 *
 * Only https URLs are accepted. The response must be OK, must look like a PDF
 * (Content-Type containing "pdf" or a body starting with the PDF magic "%PDF-")
 * and must not exceed maxBytes; content that passes no check is rejected.
 * The file name is either derived safely from the URL or taken from
 * options.fileName after a basename/traversal check. Nothing is written to
 * disk unless targetDir was passed in by the caller.
 *
 * @returns the absolute written path, hex SHA-256 and byte count.
 * @throws DownloadError with a bounded message for every failure.
 */
export async function downloadOpenPdf(
  url: string,
  targetDir: string,
  options: DownloadPdfOptions = {},
): Promise<DownloadResult> {
  assertPdfUrl(url);
  if (typeof targetDir !== "string" || targetDir.length === 0 || targetDir.length > MAX_URL_OR_PATH_LENGTH) {
    throw new DownloadError("targetDir must be a string of at most " + MAX_URL_OR_PATH_LENGTH + " characters");
  }
  if (!path.isAbsolute(targetDir)) {
    throw new DownloadError("targetDir must be an absolute path");
  }
  const fileName = resolveFileName(url, options.fileName);
  const maxBytes =
    typeof options.maxBytes === "number" && options.maxBytes > 0 ? Math.floor(options.maxBytes) : MAX_DOWNLOAD_BYTES;

  mkdirSync(targetDir, { recursive: true });
  const targetPath = path.join(targetDir, fileName);

  const fetchFn = options.fetchFn ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchFn(url, { redirect: "follow", signal: options.signal });
  } catch (error) {
    throw new DownloadError("pdf request failed: " + underlyingMessage(error));
  }
  if (!response.ok) {
    throw new DownloadError("HTTP " + response.status + " while downloading pdf");
  }
  if (response.body === null) {
    throw new DownloadError("remote content is not a PDF");
  }

  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  const typeLooksLikePdf = contentType.indexOf("pdf") >= 0;
  const reader = response.body.getReader();
  const hash = createHash("sha256");
  let stream: WriteStream | null = null;
  let headBytes = Buffer.alloc(0);
  let total = 0;

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      const chunk = result.value;
      if (chunk === undefined || chunk.byteLength === 0) {
        continue;
      }
      total += chunk.byteLength;
      if (total > maxBytes) {
        throw new DownloadError("pdf exceeds the " + maxBytes + " byte limit");
      }
      if (!typeLooksLikePdf) {
        const needed = MAGIC_BYTES - headBytes.length;
        if (needed > 0) {
          headBytes = Buffer.concat([headBytes, Buffer.from(chunk.subarray(0, Math.min(needed, chunk.byteLength)))]);
        }
        if (headBytes.length >= MAGIC_BYTES) {
          if (headBytes.subarray(0, MAGIC_BYTES).toString("latin1") !== PDF_MAGIC) {
            throw new DownloadError("remote content is not a PDF");
          }
          headBytes = Buffer.alloc(0);
        }
      }
      if (stream === null) {
        stream = createWriteStream(targetPath, { flags: "w" });
      }
      hash.update(chunk);
      await writeChunk(stream, chunk);
    }

    if (total === 0) {
      throw new DownloadError("remote content is empty");
    }
    if (!typeLooksLikePdf && headBytes.length > 0 && headBytes.length < MAGIC_BYTES) {
      throw new DownloadError("remote content is not a PDF");
    }
    if (stream === null) {
      throw new DownloadError("remote content is not a PDF");
    }
    const output = stream;
    await new Promise<void>((resolve, reject) => {
      output.once("error", reject);
      output.end(() => resolve());
    });
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // Stream already closed; nothing else to cancel.
    }
    if (stream !== null) {
      try {
        stream.destroy();
      } catch {
        // Best-effort cleanup.
      }
    }
    try {
      rmSync(targetPath, { force: true });
    } catch {
      // Best-effort cleanup.
    }
    throw toDownloadError(error);
  }

  return { path: targetPath, sha256: hash.digest("hex"), bytes: total };
}
