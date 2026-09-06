import { MAX_REPAIR_ROUNDS, type ReproductionPhase } from "./types.ts";

/**
 * Legal phase transitions for a reproduction plan.
 *
 * repairing (verifying -> running) is always allowed by the state machine
 * itself; callers gate it with canRepair() so a plan cannot loop forever.
 */
const transitions: Record<ReproductionPhase, ReadonlySet<ReproductionPhase>> = {
  planned: new Set(["preparing"]),
  preparing: new Set(["running", "blocked"]),
  running: new Set(["verifying", "blocked"]),
  verifying: new Set(["completed", "blocked", "running"]),
  completed: new Set([]),
  blocked: new Set([]),
};

/** Throw a bounded error unless the phase transition is legal. */
export function assertReproductionTransition(from: ReproductionPhase, to: ReproductionPhase): void {
  if (!transitions[from].has(to)) throw new Error(`illegal reproduction transition: ${from} -> ${to}`);
}

/** Completed and blocked plans cannot move to another phase. */
export function isTerminal(phase: ReproductionPhase): boolean {
  return phase === "completed" || phase === "blocked";
}

/**
 * True when a plan in the verifying phase may still go back to running for
 * another repair round. Round counting is the caller's responsibility.
 */
export function canRepair(phase: ReproductionPhase, repairRoundsUsed: number): boolean {
  return phase === "verifying" && repairRoundsUsed >= 0 && repairRoundsUsed < MAX_REPAIR_ROUNDS;
}
