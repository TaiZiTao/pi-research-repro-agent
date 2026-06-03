import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { EvidenceHit } from "../../shared/research/types.ts";

const execFileAsync = promisify(execFile);

export type HybridWorkerRequest =
  | { action: "build"; indexDir: string; chunksPath: string; paperId: string; model?: string }
  | { action: "search"; indexDir: string; paperId: string; query: string; k: number; model?: string };

export type HybridWorkerResult =
  { ok: true; action: "build"; denseAvailable: boolean } | { ok: true; action: "search"; hits: EvidenceHit[] };

type Runner = (
  file: string,
  args: string[],
  options: { windowsHide: boolean; timeout: number; maxBuffer: number },
) => Promise<{ stdout: string }>;

export async function runHybridWorker(
  python: string,
  workerPath: string,
  request: HybridWorkerRequest,
  run: Runner = execFileAsync,
): Promise<HybridWorkerResult> {
  const payload = JSON.stringify(request);
  if (Buffer.byteLength(payload, "utf8") > 16_384) throw new Error("hybrid worker request is too large");
  const { stdout } = await run(python, [workerPath, payload], {
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  let result: unknown;
  try {
    result = JSON.parse(stdout);
  } catch {
    throw new Error("hybrid worker returned invalid JSON");
  }
  if (!result || typeof result !== "object" || (result as { ok?: unknown }).ok !== true) {
    throw new Error("hybrid worker failed");
  }
  return result as HybridWorkerResult;
}
