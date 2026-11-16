import {
  DEFAULT_ACTIVE_BUDGET_MS,
  MAXIMUM_CLARIFICATION_ROUNDS,
  type BudgetSnapshot,
  type SLAController,
} from "../contracts/index.js";
import { clockEpoch, dsError, monotonicNowMs, sameClockEpoch } from "../core/index.js";

export interface ExecutionBudgetClock {
  /** Monotonic milliseconds (default: monotonicNowMs). Used for all elapsed-time accounting. */
  now?: () => number;
  /** Wall-clock milliseconds (default: Date.now). Display projection and reboot fallback only. */
  wallNow?: () => number;
  /** Boot identifier (default: clockEpoch) used to decide whether persisted monotonic stamps are comparable. */
  epoch?: () => string;
}

export interface ExecutionBudgetOptions extends ExecutionBudgetClock {
  /** Hard active-processing budget (default 60 000 ms). */
  maximumMs?: number;
  /** Maximum human-clarification pauses (default and upper bound: 3). */
  maximumRounds?: number;
  /** Attached to SLA errors for §17 reporting. */
  runId?: string;
}

type Armed = { controller: AbortController; timer?: ReturnType<typeof setTimeout> };

/**
 * §6.4 / §15.4 SLA controller with monotonic active-time accounting.
 *
 * - Only `pause("human_clarification")` stops the clock; everything else (discovery, LLM and subagent
 *   work, process gaps between CLI invocations while running) counts.
 * - Clarification never resets the budget; at most `maximumRounds` pauses are allowed.
 * - State round-trips through `snapshot()` / `fromSnapshot()` so pauses survive process boundaries.
 */
export class ExecutionBudget implements SLAController {
  private readonly now: () => number;
  private readonly wallNow: () => number;
  private readonly epoch: () => string;
  private readonly runId: string | undefined;
  private state: BudgetSnapshot;
  private readonly armed = new Set<Armed>();

  constructor(opts: ExecutionBudgetOptions = {}) {
    this.now = opts.now ?? monotonicNowMs;
    this.wallNow = opts.wallNow ?? Date.now;
    this.epoch = opts.epoch ?? clockEpoch;
    this.runId = opts.runId;
    const maximumMs = opts.maximumMs ?? DEFAULT_ACTIVE_BUDGET_MS;
    if (!Number.isFinite(maximumMs) || maximumMs <= 0) {
      throw dsError("configuration", "sla", `maximumMs must be a positive number (got ${maximumMs})`);
    }
    this.state = {
      maximumMs,
      consumedMs: 0,
      roundsUsed: 0,
      maximumRounds: clampRounds(opts.maximumRounds),
      clockEpoch: this.epoch(),
    };
  }

  /**
   * Restore a persisted budget. When the snapshot was taken in the same boot (sameClockEpoch) the
   * monotonic `activeSince` is reused, so time between processes counts exactly. After a reboot the
   * monotonic stamps are meaningless: the open segment is charged by wall-clock delta from
   * `activeSinceWallMs` (never negative) and a fresh segment starts now.
   */
  static fromSnapshot(s: BudgetSnapshot, opts: ExecutionBudgetClock & { runId?: string } = {}): ExecutionBudget {
    if (!s || !Number.isFinite(s.maximumMs) || !Number.isFinite(s.consumedMs) || typeof s.clockEpoch !== "string") {
      throw dsError("invalid_state", "sla", "Invalid budget snapshot");
    }
    const budget = new ExecutionBudget({ ...opts, maximumMs: s.maximumMs, maximumRounds: s.maximumRounds });
    const restored: BudgetSnapshot = { ...s, maximumRounds: budget.state.maximumRounds, consumedMs: Math.max(0, s.consumedMs) };
    const currentEpoch = budget.epoch();
    if (!sameClockEpoch(s.clockEpoch, currentEpoch)) {
      if (restored.activeSince !== undefined) {
        const wall = budget.wallNow();
        const since = restored.activeSinceWallMs ?? wall;
        restored.consumedMs += Math.max(0, wall - since);
        restored.activeSince = budget.now();
        restored.activeSinceWallMs = wall;
      }
      if (restored.pausedAt !== undefined) restored.pausedAt = budget.now();
      restored.clockEpoch = currentEpoch;
    }
    budget.state = restored;
    return budget;
  }

  // ---- SLAController -------------------------------------------------------

  /** Start (or keep) the active clock. Idempotent while running; use resume() after a pause. */
  start(): void {
    if (this.isPaused()) {
      throw dsError("invalid_state", "sla", "Budget is paused for human clarification; call resume()", this.errOpts());
    }
    if (this.isRunning()) return;
    this.openSegment();
    this.rearm();
  }

  pause(reason: "human_clarification"): void {
    if (reason !== "human_clarification") {
      throw dsError("invalid_state", "sla", `Only human clarification may pause the SLA (got "${String(reason)}")`, this.errOpts());
    }
    if (this.isPaused()) throw dsError("invalid_state", "sla", "Budget is already paused", this.errOpts());
    if (this.state.roundsUsed >= this.state.maximumRounds) {
      throw dsError(
        "clarification",
        "sla",
        `Clarification round limit reached (${this.state.maximumRounds}); proceed with documented assumptions`,
        { ...this.errOpts(), recoverable: true, fallbackAction: "Proceed using documented assumptions." },
      );
    }
    this.closeSegment();
    this.state.pausedAt = this.now();
    this.state.pauseReason = "human_clarification";
    this.state.roundsUsed++;
    this.disarmAll();
  }

  resume(): void {
    if (!this.isPaused()) throw dsError("invalid_state", "sla", "Budget is not paused", this.errOpts());
    delete this.state.pausedAt;
    delete this.state.pauseReason;
    this.openSegment();
    this.rearm();
  }

  remainingMs(): number {
    return Math.max(0, this.state.maximumMs - this.consumedMs());
  }

  /** Manual accounting for work measured elsewhere (e.g. host-reported LLM time). */
  consume(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) throw dsError("invalid_state", "sla", `consume() needs a non-negative duration (got ${ms})`, this.errOpts());
    this.state.consumedMs += ms;
    this.rearm();
  }

  isExpired(): boolean {
    return this.remainingMs() <= 0;
  }

  isPaused(): boolean {
    return this.state.pausedAt !== undefined;
  }

  consumedMs(): number {
    const open = this.state.activeSince !== undefined ? Math.max(0, this.now() - this.state.activeSince) : 0;
    return this.state.consumedMs + open;
  }

  snapshot(): BudgetSnapshot {
    return { ...this.state };
  }

  // ---- §15.4 aliases ---------------------------------------------------------

  pauseForHuman(): void {
    this.pause("human_clarification");
  }

  resumeAfterHuman(): void {
    this.resume();
  }

  getRemainingMs(): number {
    return this.remainingMs();
  }

  /** Throws sla_expired (§15.5) when the active budget is exhausted. */
  assertWithinBudget(): void {
    if (this.isExpired()) throw this.expiredError();
  }

  // ---- extras ------------------------------------------------------------------

  isRunning(): boolean {
    return this.state.activeSince !== undefined;
  }

  get roundsUsed(): number {
    return this.state.roundsUsed;
  }

  get maximumRounds(): number {
    return this.state.maximumRounds;
  }

  get maximumMs(): number {
    return this.state.maximumMs;
  }

  /** ISO projection of when the budget runs out if no further pauses occur (display only). */
  deadlineAt(): string {
    return new Date(this.wallNow() + this.remainingMs()).toISOString();
  }

  /**
   * A signal that aborts (reason: DynamicSkillsError "sla_expired") when the remaining active budget runs
   * out. The countdown only runs while the budget is running; it is suspended during a human pause and
   * re-armed on resume/start/consume. Already-expired budgets yield an aborted signal.
   */
  createAbortSignal(): AbortSignal {
    const entry: Armed = { controller: new AbortController() };
    this.armed.add(entry);
    this.arm(entry);
    return entry.controller.signal;
  }

  // ---- internals -------------------------------------------------------------

  private openSegment(): void {
    this.state.activeSince = this.now();
    this.state.activeSinceWallMs = this.wallNow();
  }

  private closeSegment(): void {
    if (this.state.activeSince === undefined) return;
    this.state.consumedMs += Math.max(0, this.now() - this.state.activeSince);
    delete this.state.activeSince;
    delete this.state.activeSinceWallMs;
  }

  private arm(entry: Armed): void {
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    delete entry.timer;
    if (entry.controller.signal.aborted) {
      this.armed.delete(entry);
      return;
    }
    if (this.isExpired()) {
      entry.controller.abort(this.expiredError());
      this.armed.delete(entry);
      return;
    }
    if (!this.isRunning()) return; // paused or not started: no countdown
    const timer = setTimeout(() => this.arm(entry), Math.max(1, Math.ceil(this.remainingMs())));
    (timer as { unref?: () => void }).unref?.();
    entry.timer = timer;
  }

  private rearm(): void {
    for (const entry of [...this.armed]) this.arm(entry);
  }

  private disarmAll(): void {
    for (const entry of this.armed) {
      if (entry.timer !== undefined) clearTimeout(entry.timer);
      delete entry.timer;
    }
  }

  private expiredError() {
    return dsError("sla_expired", "sla", `Active processing budget of ${this.state.maximumMs} ms exhausted`, {
      ...this.errOpts(),
      elapsedActiveMs: Math.round(this.consumedMs()),
      recoverable: false,
      fallbackAction:
        "Abort outstanding work, do not activate unvalidated artifacts, preserve verified evidence and return control to the root agent to continue with existing capabilities.",
    });
  }

  private errOpts(): { runId?: string; elapsedActiveMs: number } {
    return { ...(this.runId !== undefined ? { runId: this.runId } : {}), elapsedActiveMs: Math.round(this.consumedMs()) };
  }
}

function clampRounds(n: number | undefined): number {
  if (n === undefined || !Number.isFinite(n)) return MAXIMUM_CLARIFICATION_ROUNDS;
  return Math.max(0, Math.min(MAXIMUM_CLARIFICATION_ROUNDS, Math.floor(n)));
}
