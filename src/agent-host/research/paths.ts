import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const MAX_PDF_BYTES = 100 * 1024 * 1024;

export interface ResearchProjectPaths {
  projectRoot: string;
  inputRoot: string;
  evidenceRoot: string;
  managedPdfPath: string;
  chunksPath: string;
  projectFile: string;
  skillsRoot: string;
}

export interface InspectedPdfInput {
  canonicalPath: string;
  size: number;
  name: string;
}

export function researchProjectPaths(root: string, projectId: string): ResearchProjectPaths {
  if (!UUID_V4_PATTERN.test(projectId)) {
    throw new Error("Research project ID must be an RFC-4122 version-4 UUID");
  }

  const projectsRoot = path.resolve(root, "projects");
  const projectRoot = path.resolve(projectsRoot, projectId);
  const relativeProjectRoot = path.relative(projectsRoot, projectRoot);
  if (
    relativeProjectRoot === ".." ||
    relativeProjectRoot.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeProjectRoot)
  ) {
    throw new Error("Research project path must remain beneath the projects root");
  }

  const inputRoot = path.join(projectRoot, "input");
  const evidenceRoot = path.join(projectRoot, "evidence");
  return {
    projectRoot,
    inputRoot,
    evidenceRoot,
    managedPdfPath: path.join(inputRoot, "paper.pdf"),
    chunksPath: path.join(evidenceRoot, "chunks.json"),
    projectFile: path.join(projectRoot, "research-project.json"),
    skillsRoot: path.join(projectRoot, ".pi", "skills"),
  };
}

export function inspectPdfInput(input: string): InspectedPdfInput {
  if (!path.isAbsolute(input)) {
    throw new Error("PDF input path must be absolute");
  }

  const canonicalPath = realpathSync(input);
  if (path.extname(canonicalPath).toLowerCase() !== ".pdf") {
    throw new Error("PDF input must have a .pdf extension");
  }

  const stats = statSync(canonicalPath);
  if (!stats.isFile()) {
    throw new Error("PDF input must be a regular file");
  }
  if (stats.size === 0) {
    throw new Error("PDF input must not be empty");
  }
  if (stats.size > MAX_PDF_BYTES) {
    throw new Error(`PDF input must not exceed ${MAX_PDF_BYTES} bytes`);
  }

  const descriptor = openSync(canonicalPath, "r");
  try {
    const signature = Buffer.alloc(5);
    const bytesRead = readSync(descriptor, signature, 0, signature.length, 0);
    if (bytesRead !== signature.length || !signature.equals(Buffer.from("%PDF-", "ascii"))) {
      throw new Error("PDF input has an invalid signature");
    }
  } finally {
    closeSync(descriptor);
  }

  return {
    canonicalPath,
    size: stats.size,
    name: path.basename(canonicalPath),
  };
}
