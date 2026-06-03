import { execFile } from "node:child_process";
import { promisify } from "node:util";

const defaultRunner = promisify(execFile);

export async function runPaperParser(
  python: string,
  worker: string,
  pdf: string,
  output: string,
  run: typeof defaultRunner = defaultRunner,
): Promise<void> {
  await run(python, [worker, pdf, output], {
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });
}
