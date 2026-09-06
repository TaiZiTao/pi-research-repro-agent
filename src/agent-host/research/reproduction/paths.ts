import { mkdir } from "node:fs/promises";
import path from "node:path";

export interface ReproductionPaths {
  /** Root of everything this plan owns, e.g. <projectWorkspace>/reproduction. */
  root: string;
  /** Working directory where step commands run and write their outputs. */
  workspace: string;
  /** Root under which step artifacts are collected (relative artifactRefs). */
  artifactsRoot: string;
  /** JSON state file that mirrors the persisted plan. */
  stateFile: string;
}

function assertBeneath(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`reproduction ${label} must remain beneath the reproduction root`);
  }
}

/**
 * Derive the reproduction directory layout for a project workspace.
 *
 * The workspace must be absolute; every derived path is resolved and verified
 * to stay beneath <projectWorkspace>/reproduction (defense in depth).
 */
export function reproductionPaths(projectWorkspace: string): ReproductionPaths {
  if (!path.isAbsolute(projectWorkspace)) {
    throw new Error("Project workspace must be an absolute path");
  }
  const root = path.resolve(projectWorkspace, "reproduction");
  const workspace = path.resolve(root, "workspace");
  const artifactsRoot = path.resolve(root, "artifacts");
  const stateFile = path.join(root, "reproduction-plan.json");
  assertBeneath(root, workspace, "workspace");
  assertBeneath(root, artifactsRoot, "artifacts root");
  assertBeneath(root, stateFile, "state file");
  return { root, workspace, artifactsRoot, stateFile };
}

/** Create the reproduction directories recursively; idempotent. */
export async function ensureReproductionDirs(paths: ReproductionPaths): Promise<void> {
  await mkdir(paths.root, { recursive: true });
  await mkdir(paths.workspace, { recursive: true });
  await mkdir(paths.artifactsRoot, { recursive: true });
}
