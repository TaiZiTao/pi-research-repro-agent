/**
 * Qwen LoRA shadow mode: a side-channel predictor that never executes tools
 * and never affects the host (DeepSeek) agent. The model+adapter worker is
 * spawned once per process and kept alive; every failure degrades silently.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type QwenShadowMode = "off" | "shadow";

export interface ShadowConfig {
  mode: QwenShadowMode;
  python: string;
  workerPath: string;
  model: string;
  adapter: string | null;
  logPath: string;
  /** Per-request timeout in ms (default 30s; model load happens before ready). */
  timeoutMs: number;
  /** Injectable process launcher for tests. */
  spawn?: (python: string, args: string[], options: { env: NodeJS.ProcessEnv }) => ChildProcess;
}

export interface ShadowPrediction {
  action: string;
  arguments: Record<string, unknown>;
  jsonValid: boolean;
  latencyMs: number;
}

export interface ShadowLogRecord {
  ts: string;
  sessionHash: string;
  qwen: ShadowPrediction | null;
  deepseek: { action: string; arguments: Record<string, unknown> } | null;
  match: boolean | null;
  note?: string;
}

const DEFAULT_PYTHON = "D:\\anaconda3\\python.exe";
const DEFAULT_MODEL = "E:\\deepseek\\models\\Qwen3-0.6B";

export function sha256Short(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

const SECRET_PATTERN = /(?:ghp_|github_pat_|sk-)[A-Za-z0-9_-]{8,}/gi;
const WINDOWS_PATH_PATTERN = /[A-Za-z]:\\(?:[^\s"\'<>|]+\\)*[^\s"\'<>|]*/g;
const HOME_PATH_PATTERN = /(?:\/home|\/Users)\/[^\s"\'<>|]+/g;

/** Redact secrets and local paths from a string; non-string values pass through. */
export function redactText(value: string): string {
  return value
    .replace(SECRET_PATTERN, "[redacted-token]")
    .replace(WINDOWS_PATH_PATTERN, "[redacted-path]")
    .replace(HOME_PATH_PATTERN, "[redacted-path]");
}

export function redactArguments(arguments_: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(arguments_)) {
    if (typeof value === "string") {
      out[key] = redactText(value);
    } else if (Array.isArray(value)) {
      out[key] = value.map((item) => (typeof item === "string" ? redactText(item) : item));
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function fromEnv(env: NodeJS.ProcessEnv): ShadowConfig {
  const mode: QwenShadowMode = env.RESEARCH_QWEN_MODE === "shadow" ? "shadow" : "off";
  const python =
    env.RESEARCH_QWEN_PYTHON && env.RESEARCH_QWEN_PYTHON.trim().length > 0 ? env.RESEARCH_QWEN_PYTHON : DEFAULT_PYTHON;
  const model =
    env.RESEARCH_QWEN_MODEL && env.RESEARCH_QWEN_MODEL.trim().length > 0 ? env.RESEARCH_QWEN_MODEL : DEFAULT_MODEL;
  const adapter =
    env.RESEARCH_QWEN_ADAPTER && env.RESEARCH_QWEN_ADAPTER.trim().length > 0 ? env.RESEARCH_QWEN_ADAPTER : null;
  const logPath = env.RESEARCH_QWEN_LOG && env.RESEARCH_QWEN_LOG.trim().length > 0 ? env.RESEARCH_QWEN_LOG : "";
  const appRoot =
    env.PI_DESKTOP_APP_ROOT && env.PI_DESKTOP_APP_ROOT.trim().length > 0
      ? env.PI_DESKTOP_APP_ROOT
      : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  return {
    mode,
    python,
    workerPath: path.join(appRoot, "python", "agent_shadow", "qwen_shadow_worker.py"),
    model,
    adapter,
    logPath,
    timeoutMs: 30_000,
  };
}

export interface ShadowPredictor {
  mode: QwenShadowMode;
  /** Predict the next action from a chat context; null on any failure. */
  predict(messages: Array<{ role: string; content: string }>): Promise<ShadowPrediction | null>;
  close(): void;
}

function neverPrediction(): ShadowPredictor {
  return {
    mode: "off" as const,
    async predict() {
      return null;
    },
    close() {
      /* nothing to do */
    },
  };
}

export class QwenShadowPredictor implements ShadowPredictor {
  readonly mode: QwenShadowMode = "shadow";
  readonly #config: ShadowConfig;
  #child: ChildProcess | null = null;
  #pending = new Map<
    string,
    { resolve: (value: ShadowPrediction | null) => void; timer: ReturnType<typeof setTimeout> }
  >();
  #ready = false;
  #dead = false;
  #queue: Array<{
    messages: Array<{ role: string; content: string }>;
    resolve: (value: ShadowPrediction | null) => void;
  }> = [];

  constructor(config: ShadowConfig) {
    this.#config = config;
  }

  #start(): void {
    if (this.#child || this.#dead) return;
    const worker = this.#config.workerPath;
    if (!worker || !this.#config.adapter) {
      this.#dead = true;
      return;
    }
    const env = { ...process.env };
    env.RESEARCH_QWEN_MODEL = this.#config.model;
    env.RESEARCH_QWEN_ADAPTER = this.#config.adapter;
    const spawnFn = this.#config.spawn ?? spawn;
    let child: ChildProcess;
    try {
      child = spawnFn(this.#config.python, [worker], { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      this.#dead = true;
      return;
    }
    this.#child = child;
    child.once("exit", () => {
      this.#dead = true;
      this.#child = null;
      for (const entry of this.#pending.values()) {
        clearTimeout(entry.timer);
        entry.resolve(null);
      }
      this.#pending.clear();
      this.#flushQueue();
    });
    const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    lines.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let payload: {
        id?: unknown;
        event?: unknown;
        ok?: unknown;
        action?: unknown;
        arguments?: unknown;
        jsonValid?: unknown;
        latencyMs?: unknown;
        error?: unknown;
      };
      try {
        payload = JSON.parse(trimmed) as typeof payload;
      } catch {
        return;
      }
      if (payload.event === "ready") {
        this.#ready = true;
        this.#flushQueue();
        return;
      }
      const id = String(payload.id ?? "");
      const entry = this.#pending.get(id);
      if (!entry) return;
      this.#pending.delete(id);
      clearTimeout(entry.timer);
      if (payload.ok === true && typeof payload.action === "string") {
        entry.resolve({
          action: payload.action,
          arguments: (payload.arguments ?? {}) as Record<string, unknown>,
          jsonValid: payload.jsonValid === true,
          latencyMs: typeof payload.latencyMs === "number" ? payload.latencyMs : 0,
        });
      } else {
        entry.resolve(null);
      }
    });
  }

  #flushQueue(): void {
    if (!this.#ready || this.#dead) {
      if (this.#dead) {
        for (const entry of this.#queue.splice(0)) entry.resolve(null);
      }
      return;
    }
    for (const entry of this.#queue.splice(0)) {
      void this.#request(entry.messages, entry.resolve);
    }
  }

  #request(
    messages: Array<{ role: string; content: string }>,
    resolve: (value: ShadowPrediction | null) => void,
  ): void {
    if (!this.#child || this.#dead || !this.#ready) {
      resolve(null);
      return;
    }
    const id = "shadow-" + Math.random().toString(36).slice(2) + "-" + Date.now().toString(36);
    const timer = setTimeout(() => {
      this.#pending.delete(id);
      resolve(null);
    }, this.#config.timeoutMs);
    this.#pending.set(id, { resolve, timer });
    try {
      this.#child.stdin!.write(JSON.stringify({ id, messages }) + "\n");
    } catch {
      this.#pending.delete(id);
      clearTimeout(timer);
      resolve(null);
    }
  }

  async predict(messages: Array<{ role: string; content: string }>): Promise<ShadowPrediction | null> {
    if (!messages || messages.length === 0) return null;
    this.#start();
    if (this.#dead) return null;
    if (!this.#ready) {
      return await new Promise<ShadowPrediction | null>((resolve) => {
        this.#queue.push({ messages, resolve });
        setTimeout(() => this.#flushQueue(), 0);
      });
    }
    return await new Promise<ShadowPrediction | null>((resolve) => {
      this.#request(messages, resolve);
    });
  }

  close(): void {
    if (this.#child) {
      try {
        this.#child.kill();
      } catch {
        /* best effort */
      }
    }
    this.#dead = true;
  }
}

/** Create the configured predictor; off mode never spawns or loads the model. */
export function createQwenShadow(config: ShadowConfig): ShadowPredictor {
  if (config.mode !== "shadow") return neverPrediction();
  return new QwenShadowPredictor(config);
}

export interface ShadowLogOptions {
  sessionId: string;
  logPath: string;
}

/** Append one redacted comparison record as a JSONL line. Never stores keys, paper text or raw paths. */
export function logShadowRecord(record: ShadowLogRecord, options: ShadowLogOptions): void {
  if (!options.logPath) return;
  const line = JSON.stringify({
    ts: record.ts,
    sessionHash: sha256Short(options.sessionId),
    qwen: record.qwen === null ? null : { ...record.qwen, arguments: redactArguments(record.qwen.arguments) },
    deepseek:
      record.deepseek === null
        ? null
        : { action: record.deepseek.action, arguments: redactArguments(record.deepseek.arguments) },
    match: record.match,
    note: record.note,
  });
  try {
    appendFileSync(options.logPath, line + "\n", "utf8");
  } catch {
    /* logging must never break the agent */
  }
}

export interface AssistantEventMessage {
  role?: unknown;
  content?: unknown;
  tool_calls?: unknown;
  toolCalls?: unknown;
}

/**
 * Best-effort extraction of the DeepSeek decision from an assistant message.
 * Understands OpenAI-style tool_calls and plain text; anything else is null.
 */
export function extractAssistantAction(
  message: AssistantEventMessage | null | undefined,
): { action: string; arguments: Record<string, unknown> } | null {
  if (!message || typeof message !== "object") return null;
  const calls = (message.tool_calls ?? message.toolCalls) as unknown;
  if (Array.isArray(calls) && calls.length > 0) {
    const first = calls[0] as { function?: { name?: unknown; arguments?: unknown } } | null | undefined;
    const name = first?.function?.name;
    if (typeof name === "string" && name.length > 0) {
      const raw = first?.function?.arguments;
      let parsedArguments: Record<string, unknown> = {};
      if (typeof raw === "string") {
        try {
          const value = JSON.parse(raw) as unknown;
          if (value && typeof value === "object" && !Array.isArray(value))
            parsedArguments = value as Record<string, unknown>;
        } catch {
          /* malformed arguments are kept empty */
        }
      } else if (raw && typeof raw === "object") {
        parsedArguments = raw as Record<string, unknown>;
      }
      return { action: name, arguments: parsedArguments };
    }
  }
  const text = messageText(message.content);
  if (text) return { action: "__answer__", arguments: {} };
  return null;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === "object") {
        const record = block as { type?: unknown; text?: unknown; content?: unknown };
        if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
      }
    }
    return parts.join("\n").trim();
  }
  return "";
}

export interface StateMessageLike {
  role?: unknown;
  content?: unknown;
}

/**
 * Collapse recent agent-state messages into the shadow chat context
 * ({ role, content } pairs, at most maxContext messages). Tool results are
 * mapped to role "tool" with bounded text so the worker template stays valid.
 */
export function buildShadowContext(
  stateMessages: readonly StateMessageLike[] | null | undefined,
  maxContext = 4,
): Array<{ role: string; content: string }> {
  if (!Array.isArray(stateMessages)) return [];
  const out: Array<{ role: string; content: string }> = [];
  for (const message of stateMessages) {
    if (!message || typeof message !== "object") continue;
    let role = typeof message.role === "string" ? message.role : "";
    if (role === "toolResult") role = "tool";
    if (role !== "user" && role !== "assistant" && role !== "tool") continue;
    let content = messageText(message.content);
    if (role === "tool") content = content.slice(0, 2000);
    if (content.length === 0 && role === "tool") content = "{}";
    if (role === "assistant" && Array.isArray(message.content)) {
      const calls =
        (message as { tool_calls?: unknown; toolCalls?: unknown }).tool_calls ??
        (message as { toolCalls?: unknown }).toolCalls;
      if (Array.isArray(calls) && calls.length > 0) {
        content = "tool calls issued";
      }
    }
    if (!content) continue;
    out.push({ role, content: content.slice(0, 4000) });
  }
  return out.slice(-maxContext);
}
