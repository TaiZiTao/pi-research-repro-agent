import { statSync } from "node:fs";
import path from "node:path";

const DEVELOPMENT_PYTHON = "D:\\anaconda3\\python.exe";

export interface ResearchRuntimePaths {
  researchRoot: string;
  databasePath: string;
  python: string;
  workerPath: string;
  skillsSourceRoot: string;
}

export class ResearchRuntimeConfigurationError extends Error {
  constructor(message: string) {
    super(`Research runtime unavailable: ${message}`);
    this.name = "ResearchRuntimeConfigurationError";
  }
}

function absoluteEnvironmentPath(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value || !path.isAbsolute(value)) {
    throw new ResearchRuntimeConfigurationError(`${name} must be an absolute path`);
  }
  return path.resolve(value);
}

function requireFile(filePath: string, label: string): void {
  try {
    if (!statSync(filePath).isFile()) throw new Error("not a file");
  } catch {
    throw new ResearchRuntimeConfigurationError(`${label} is missing or is not a file`);
  }
}

function requireDirectory(directoryPath: string, label: string): void {
  try {
    if (!statSync(directoryPath).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new ResearchRuntimeConfigurationError(`${label} is missing or is not a directory`);
  }
}

export function resolveResearchRuntimePaths(env: NodeJS.ProcessEnv): ResearchRuntimePaths {
  const userData = absoluteEnvironmentPath(env, "PI_DESKTOP_USER_DATA");
  const appRoot = absoluteEnvironmentPath(env, "PI_DESKTOP_APP_ROOT");
  const resources = absoluteEnvironmentPath(env, "PI_DESKTOP_RESOURCES");
  const packaged = env.PI_DESKTOP_PACKAGED === "1";
  const configuredPython = env.RESEARCH_PYTHON;
  if (packaged && (!configuredPython || !path.isAbsolute(configuredPython))) {
    throw new ResearchRuntimeConfigurationError("RESEARCH_PYTHON must be an absolute path in packaged builds");
  }
  if (configuredPython && !path.isAbsolute(configuredPython)) {
    throw new ResearchRuntimeConfigurationError("RESEARCH_PYTHON must be an absolute path");
  }

  const python = path.resolve(configuredPython || DEVELOPMENT_PYTHON);
  const workerPath = packaged
    ? path.join(resources, "research", "python", "parse_pdf.py")
    : path.join(appRoot, "python", "paper_worker", "parse_pdf.py");
  const skillsSourceRoot = packaged
    ? path.join(resources, "research", "skills")
    : path.join(appRoot, "resources", "research-skills");
  requireFile(python, "Research Python executable");
  requireFile(workerPath, "Research parser worker");
  requireDirectory(skillsSourceRoot, "Research Skill root");

  const researchRoot = path.join(userData, "research");
  return {
    researchRoot,
    databasePath: path.join(researchRoot, "research.sqlite"),
    python,
    workerPath,
    skillsSourceRoot,
  };
}
