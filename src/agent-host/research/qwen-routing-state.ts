export type QwenRoutingMode = "off" | "router" | "agent";

export function qwenRoutingModeFromEnv(env: NodeJS.ProcessEnv = process.env): QwenRoutingMode {
  if (env.RESEARCH_QWEN_AGENT === "1") return "agent";
  if (env.RESEARCH_QWEN_ROUTER === "1") return "router";
  return "off";
}

let routingMode: QwenRoutingMode = qwenRoutingModeFromEnv();

export function getQwenRoutingMode(): QwenRoutingMode {
  return routingMode;
}

export function setQwenRoutingMode(value: unknown): QwenRoutingMode {
  if (value !== "off" && value !== "router" && value !== "agent") {
    throw new Error("Invalid Qwen routing mode");
  }
  routingMode = value;
  return routingMode;
}

export function resetQwenRoutingModeForTests(value?: QwenRoutingMode): void {
  routingMode = value ?? qwenRoutingModeFromEnv();
}
