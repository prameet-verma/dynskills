import type { GenerationState } from "../contracts/index.js";
import { dsError } from "../core/index.js";

/** §4.1 lifecycle transitions. Self-loops on CONTEXT_ANALYSIS model bounded targeted discovery (§5.5). */
const TRANSITIONS: Record<GenerationState, readonly GenerationState[]> = {
  RECEIVED: ["PREFLIGHT"],
  PREFLIGHT: ["REUSE_EXISTING", "DISCOVERY"],
  DISCOVERY: ["CONTEXT_ANALYSIS", "DEGRADED"],
  CONTEXT_ANALYSIS: ["CONTEXT_ANALYSIS", "CLARIFICATION_PENDING", "COMPILATION"],
  CLARIFICATION_PENDING: ["CONTEXT_ANALYSIS"],
  COMPILATION: ["GENERATION_EVAL", "FAILED"],
  GENERATION_EVAL: ["BEHAVIOURAL_EVAL", "COMPILATION", "FAILED"],
  BEHAVIOURAL_EVAL: ["READY", "COMPILATION", "FAILED"],
  READY: ["ACTIVATION"],
  ACTIVATION: ["ACTIVE", "FAILED"],
  ACTIVE: ["PERSISTENCE_PENDING", "COMPLETED"],
  PERSISTENCE_PENDING: ["COMPLETED"],
  COMPLETED: [],
  REUSE_EXISTING: [],
  DEGRADED: [],
  FAILED: [],
};

export const TERMINAL_STATES: ReadonlySet<GenerationState> = new Set(["COMPLETED", "REUSE_EXISTING", "DEGRADED", "FAILED"]);

/** States in which the active-processing budget can expire (§15.5): any non-terminal state except human waiting. */
export function canDegrade(state: GenerationState): boolean {
  return !TERMINAL_STATES.has(state) && state !== "ACTIVE" && state !== "PERSISTENCE_PENDING";
}

export function canTransition(from: GenerationState, to: GenerationState): boolean {
  if (to === "DEGRADED" && canDegrade(from)) return true;
  if (to === "FAILED" && !TERMINAL_STATES.has(from) && from !== "ACTIVE" && from !== "PERSISTENCE_PENDING") return true;
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: GenerationState, to: GenerationState, runId?: string): void {
  if (!canTransition(from, to)) {
    throw dsError("invalid_state", "orchestrator", `Illegal state transition ${from} → ${to}`, {
      ...(runId ? { runId } : {}),
      recoverable: false,
      fallbackAction: "Check the run status and resubmit the step the run is waiting for.",
    });
  }
}

/** The single bridge command a run in `state` is waiting for. */
export function expectedCommand(state: GenerationState): string | undefined {
  switch (state) {
    case "CONTEXT_ANALYSIS":
      return "analyze";
    case "CLARIFICATION_PENDING":
      return "clarify";
    case "COMPILATION":
      return "compile";
    case "ACTIVE":
    case "PERSISTENCE_PENDING":
      return "persist";
    default:
      return undefined;
  }
}
