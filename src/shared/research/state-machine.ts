import type { ResearchProjectStatus } from "./types.ts";

const transitions: Record<ResearchProjectStatus, ReadonlySet<ResearchProjectStatus>> = {
  created: new Set(["acquiring", "cancelled"]),
  acquiring: new Set(["ingesting", "failed", "cancelled"]),
  ingesting: new Set(["ready", "failed", "cancelled"]),
  ready: new Set([]),
  failed: new Set([]),
  cancelled: new Set([]),
};

export function assertResearchTransition(from: ResearchProjectStatus, to: ResearchProjectStatus): void {
  if (!transitions[from].has(to)) throw new Error(`illegal research transition: ${from} -> ${to}`);
}
