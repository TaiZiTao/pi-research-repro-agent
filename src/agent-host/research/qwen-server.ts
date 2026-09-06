/**
 * Local Qwen3 LoRA OpenAI-compatible inference server lifecycle.
 *
 * Spawns python/agent_shadow/qwen_openai_server.py (model + optional LoRA
 * adapter loaded once) and answers /v1/models probes. The server itself only
 * produces chat completions; the host-side research-only tool gate decides
 * what the model may actually invoke in a session.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MODEL, DEFAULT_PYTHON } from "./qwen-shadow.ts";

export const RESEARCH_QWEN_PORT = 8123;
export const RESEARCH_QWEN_BASE_URL = `http://127.0.0.1:${RESEARCH_QWEN_PORT}/v1`;

export interface QwenServeConfig {
  python: string;
  serverPath: string;
  model: string;
  adapter: string | null;
}

export interface QwenServeStatus {
  running: boolean;
  /** True when a child process exists but the HTTP endpoint is not yet answering. */
  starting: boolean;
  models: string[];
  error: string | null;
}

export function resolveQwenServeConfig(env: NodeJS.ProcessEnv = process.env): QwenServeConfig {
  const appRoot =
    env.PI_DESKTOP_APP_ROOT && env.PI_DESKTOP_APP_ROOT.trim().length > 0
      ? env.PI_DESKTOP_APP_ROOT
      : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const python =
    env.RESEARCH_QWEN_PYTHON && env.RESEARCH_QWEN_PYTHON.trim().length > 0 ? env.RESEARCH_QWEN_PYTHON : DEFAULT_PYTHON;
  const model =
    env.RESEARCH_QWEN_MODEL && env.RESEARCH_QWEN_MODEL.trim().length > 0 ? env.RESEARCH_QWEN_MODEL : DEFAULT_MODEL;
  const bundledAdapter = path.join(appRoot, "training", "outputs", "qwen3-0.6b-lora-answer-1.5", "adapter");
  const adapter =
    env.RESEARCH_QWEN_ADAPTER && env.RESEARCH_QWEN_ADAPTER.trim().length > 0
      ? env.RESEARCH_QWEN_ADAPTER
      : existsSync(path.join(bundledAdapter, "adapter_config.json"))
        ? bundledAdapter
        : null;
  return {
    python,
    serverPath: path.join(appRoot, "python", "agent_shadow", "qwen_openai_server.py"),
    model,
    adapter,
  };
}

let child: ChildProcess | null = null;

export function qwenServerChildAlive(): boolean {
  return child !== null && child.exitCode === null && !child.killed;
}

export async function probeQwenServer(timeoutMs = 1500): Promise<QwenServeStatus> {
  try {
    const response = await fetch(`${RESEARCH_QWEN_BASE_URL}/models`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return { running: false, starting: qwenServerChildAlive(), models: [], error: `HTTP ${response.status}` };
    }
    const data = (await response.json()) as { data?: Array<{ id?: unknown }> } | undefined;
    const models = Array.isArray(data?.data)
      ? data.data.map((item) => (typeof item?.id === "string" ? item.id : "")).filter(Boolean)
      : [];
    return { running: true, starting: false, models, error: null };
  } catch (error) {
    return {
      running: false,
      starting: qwenServerChildAlive(),
      models: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Spawn the local inference server when it is not already running.
 * Returns a descriptive error instead of throwing when the config is invalid.
 */
export function startQwenServer(env: NodeJS.ProcessEnv = process.env): { ok: boolean; error?: string } {
  if (qwenServerChildAlive()) return { ok: true };
  const config = resolveQwenServeConfig(env);
  if (!existsSync(config.serverPath)) {
    return { ok: false, error: `Qwen OpenAI server not found: ${config.serverPath}` };
  }
  const serverEnv = { ...env };
  serverEnv.RESEARCH_QWEN_MODEL = config.model;
  if (config.adapter) serverEnv.RESEARCH_QWEN_ADAPTER = config.adapter;
  try {
    const spawned = spawn(config.python, [config.serverPath, "--port", String(RESEARCH_QWEN_PORT)], {
      env: serverEnv,
      windowsHide: true,
      stdio: "ignore",
    });
    child = spawned;
    spawned.once("exit", () => {
      if (child === spawned) child = null;
    });
    spawned.once("error", () => {
      if (child === spawned) child = null;
    });
    return { ok: true };
  } catch (error) {
    child = null;
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function stopQwenServer(): { stopped: boolean; error?: string } {
  const current = child;
  if (!current || current.exitCode !== null) {
    child = null;
    return { stopped: false };
  }
  try {
    current.kill();
  } catch (error) {
    return { stopped: false, error: error instanceof Error ? error.message : String(error) };
  }
  return { stopped: true };
}

/** Reset process bookkeeping (used by tests and runtime close). */
export function resetQwenServerForTests(): void {
  child = null;
}
