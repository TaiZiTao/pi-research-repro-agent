import path from "node:path";
import { fileURLToPath } from "node:url";
import { ResearchProjectService } from "./project-service.ts";
import { ResearchProjectStore } from "./project-store.ts";
import { resolveResearchRuntimePaths } from "./runtime-paths.ts";

type CliService = Pick<ResearchProjectService, "importPdf" | "listProjects" | "searchEvidence">;

interface CliRuntime {
  service: CliService;
  close: () => void;
}

export interface ResearchCliOptions {
  appRoot?: string;
  env?: NodeJS.ProcessEnv;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  createRuntime?: (env: NodeJS.ProcessEnv) => CliRuntime;
}

interface ParsedArguments {
  command: string;
  values: Map<string, string>;
}

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function parseArguments(argv: string[]): ParsedArguments {
  const [command, ...tokens] = argv;
  if (!command || !["import", "list", "search"].includes(command)) {
    throw new Error("command must be one of: import, list, search");
  }
  const values = new Map<string, string>();
  for (let index = 0; index < tokens.length; index += 2) {
    const name = tokens[index];
    const value = tokens[index + 1];
    if (!name?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`option ${name || "(missing)"} requires a value`);
    }
    if (values.has(name)) throw new Error(`option ${name} may only be provided once`);
    values.set(name, value);
  }
  return { command, values };
}

function requireOption(values: Map<string, string>, name: string): string {
  const value = values.get(name)?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function allowOnly(values: Map<string, string>, names: string[]): void {
  const allowed = new Set(names);
  for (const name of values.keys()) {
    if (!allowed.has(name)) throw new Error(`unknown option: ${name}`);
  }
}

function absolutePath(value: string, name: string): string {
  if (!path.isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return path.resolve(value);
}

function defaultRuntime(env: NodeJS.ProcessEnv): CliRuntime {
  const paths = resolveResearchRuntimePaths(env);
  const store = new ResearchProjectStore(paths.databasePath);
  const service = new ResearchProjectService(store, {
    researchRoot: paths.researchRoot,
    python: paths.python,
    workerPath: paths.workerPath,
    skillsSourceRoot: paths.skillsSourceRoot,
  });
  return { service, close: () => store.close() };
}

function success(output: (line: string) => void, payload: Record<string, unknown>): void {
  output(JSON.stringify({ ok: true, ...payload }));
}

function failure(output: (line: string) => void, error: unknown): void {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  output(JSON.stringify({ ok: false, error: message }));
}

export async function executeResearchCli(argv: string[], options: ResearchCliOptions = {}): Promise<number> {
  const stdout = options.stdout ?? ((line) => process.stdout.write(`${line}\n`));
  const stderr = options.stderr ?? ((line) => process.stderr.write(`${line}\n`));
  let runtime: CliRuntime | undefined;
  try {
    const parsed = parseArguments(argv);
    const env = { ...(options.env ?? process.env) };
    const userDataValue = parsed.values.get("--user-data") ?? env.PI_DESKTOP_USER_DATA;
    if (!userDataValue) throw new Error("--user-data or PI_DESKTOP_USER_DATA is required");
    const userData = absolutePath(userDataValue, "--user-data");
    const appRoot = path.resolve(options.appRoot ?? REPOSITORY_ROOT);
    env.PI_DESKTOP_USER_DATA = userData;
    env.PI_DESKTOP_APP_ROOT = appRoot;
    env.PI_DESKTOP_RESOURCES = path.join(appRoot, "resources");
    env.PI_DESKTOP_PACKAGED = "0";

    if (parsed.command === "import") {
      allowOnly(parsed.values, ["--pdf", "--title", "--user-data"]);
      const sourcePath = absolutePath(requireOption(parsed.values, "--pdf"), "--pdf");
      const title = parsed.values.get("--title")?.trim() || undefined;
      runtime = (options.createRuntime ?? defaultRuntime)(env);
      const project = await runtime.service.importPdf({ sourcePath, title });
      if (project.status === "failed") {
        failure(stderr, project.error ?? "paper import failed");
        return 1;
      }
      success(stdout, { command: "import", project });
      return 0;
    }

    if (parsed.command === "list") {
      allowOnly(parsed.values, ["--user-data"]);
      runtime = (options.createRuntime ?? defaultRuntime)(env);
      success(stdout, { command: "list", projects: runtime.service.listProjects() });
      return 0;
    }

    allowOnly(parsed.values, ["--project", "--query", "--limit", "--user-data"]);
    const projectId = requireOption(parsed.values, "--project");
    const query = requireOption(parsed.values, "--query");
    const limitValue = parsed.values.get("--limit") ?? "5";
    if (!/^[1-8]$/.test(limitValue)) throw new Error("--limit must be an integer from 1 to 8");
    const limit = Number(limitValue);
    runtime = (options.createRuntime ?? defaultRuntime)(env);
    const hits = await runtime.service.searchEvidence(projectId, query, limit);
    success(stdout, { command: "search", projectId, query, hits });
    return 0;
  } catch (error) {
    failure(stderr, error);
    return 1;
  } finally {
    runtime?.close();
  }
}
