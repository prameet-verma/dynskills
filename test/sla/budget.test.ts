import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import type { BudgetSnapshot, ContextGap } from "../../src/contracts/index.js";
import { ExecutionBudget } from "../../src/sla/index.js";
import { ClarificationManager } from "../../src/clarification-manager/index.js";
import { DynamicSkillsError } from "../../src/core/index.js";

const WALL0 = 1_700_000_000_000;

/** Injected monotonic + wall clock; advancing it also advances fake timers so abort timers fire. */
function fakeClock(epoch = "boot-1000") {
  let t = 1_000;
  const clock = {
    now: () => t,
    wallNow: () => WALL0 + t,
    epoch: () => epoch,
  };
  return {
    clock,
    advance(ms: number) {
      t += ms;
      vi.advanceTimersByTime(ms);
    },
  };
}

function expectDsError(fn: () => unknown, category: string): DynamicSkillsError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(DynamicSkillsError);
    expect((err as DynamicSkillsError).info.category).toBe(category);
    return err as DynamicSkillsError;
  }
  throw new Error("expected a DynamicSkillsError");
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("ExecutionBudget (§6.4, §15.4, §18.5)", () => {
  it("defaults to 60 s / 3 rounds", () => {
    const b = new ExecutionBudget();
    expect(b.maximumMs).toBe(60_000);
    expect(b.maximumRounds).toBe(3);
    expect(b.snapshot()).toMatchObject({ maximumMs: 60_000, consumedMs: 0, roundsUsed: 0, maximumRounds: 3 });
  });

  it("1. generation finishing within 60 s stays within budget", () => {
    const { clock, advance } = fakeClock();
    const b = new ExecutionBudget(clock);
    b.start();
    advance(20_000);
    expect(b.consumedMs()).toBe(20_000);
    expect(b.remainingMs()).toBe(40_000);
    expect(b.getRemainingMs()).toBe(40_000);
    expect(b.isExpired()).toBe(false);
    expect(() => b.assertWithinBudget()).not.toThrow();
  });

  it("4. human clarification pauses the timer", () => {
    const { clock, advance } = fakeClock();
    const b = new ExecutionBudget(clock);
    b.start();
    advance(10_000);
    b.pause("human_clarification");
    expect(b.isPaused()).toBe(true);
    advance(60 * 60_000);
    expect(b.consumedMs()).toBe(10_000);
    expect(b.isExpired()).toBe(false);
  });

  it("5. the SLA resumes correctly after the human answers", () => {
    const { clock, advance } = fakeClock();
    const b = new ExecutionBudget(clock);
    b.start();
    advance(10_000);
    b.pauseForHuman();
    advance(120_000);
    b.resumeAfterHuman();
    expect(b.isPaused()).toBe(false);
    advance(5_000);
    expect(b.consumedMs()).toBe(15_000);
    expect(b.remainingMs()).toBe(45_000);
  });

  it("6/7. multiple human waits do not reset the total; three rounds are allowed", () => {
    const { clock, advance } = fakeClock();
    const b = new ExecutionBudget(clock);
    b.start();
    for (let round = 1; round <= 3; round++) {
      advance(10_000);
      b.pause("human_clarification");
      expect(b.roundsUsed).toBe(round);
      advance(300_000);
      b.resume();
    }
    advance(10_000);
    expect(b.consumedMs()).toBe(40_000);
    expect(b.remainingMs()).toBe(20_000);
  });

  it("8. a fourth clarification round is rejected", () => {
    const { clock } = fakeClock();
    const b = new ExecutionBudget(clock);
    b.start();
    for (let i = 0; i < 3; i++) {
      b.pause("human_clarification");
      b.resume();
    }
    expectDsError(() => b.pause("human_clarification"), "clarification");
    expect(b.isPaused()).toBe(false);
    expect(b.roundsUsed).toBe(3);
  });

  it("rejects invalid pause/resume/start transitions", () => {
    const { clock } = fakeClock();
    const b = new ExecutionBudget(clock);
    b.start();
    b.start(); // idempotent while running
    expectDsError(() => b.pause("subagent" as "human_clarification"), "invalid_state");
    expectDsError(() => b.resume(), "invalid_state");
    b.pause("human_clarification");
    expectDsError(() => b.pause("human_clarification"), "invalid_state");
    expectDsError(() => b.start(), "invalid_state");
    expectDsError(() => b.consume(-1), "invalid_state");
    expect(() => new ExecutionBudget({ maximumMs: 0 })).toThrow(DynamicSkillsError);
  });

  it("9. declined questions become assumptions while the budget is paused, without resetting it", () => {
    const { clock, advance } = fakeClock();
    const b = new ExecutionBudget(clock);
    const m = new ClarificationManager();
    b.start();
    advance(12_000);
    const gaps: ContextGap[] = [
      { id: "gap_000000000001", category: "ambiguous_requirement", description: "Return 400 or 401?", severity: "critical", resolution: "ask_user" },
    ];
    const req = m.buildRequest("run_1", gaps, "c")!;
    b.pause("human_clarification");
    advance(90_000);
    const { assumptions } = m.recordResponse({ runId: "run_1", round: req.round, answers: [{ questionId: req.questions[0]!.id, status: "declined" }] });
    b.resume();
    expect(assumptions).toEqual([expect.objectContaining({ status: "declined", impact: "high" })]);
    expect(b.consumedMs()).toBe(12_000);
  });

  it("10. internal subagent delays count towards active processing", async () => {
    const { clock, advance } = fakeClock();
    const b = new ExecutionBudget(clock);
    b.start();
    const subagent = new Promise<void>((resolve) => setTimeout(resolve, 25_000));
    advance(25_000); // subagent runs; nobody calls consume()
    await subagent;
    expect(b.consumedMs()).toBe(25_000);
    b.consume(5_000); // manual accounting (e.g. host-reported time)
    expect(b.consumedMs()).toBe(30_000);
  });

  it("remaining time never goes negative and expiry throws sla_expired", () => {
    const { clock, advance } = fakeClock();
    const b = new ExecutionBudget({ ...clock, runId: "run_9" });
    b.start();
    advance(70_000);
    expect(b.remainingMs()).toBe(0);
    expect(b.isExpired()).toBe(true);
    const err = expectDsError(() => b.assertWithinBudget(), "sla_expired");
    expect(err.info).toMatchObject({ component: "sla", runId: "run_9", elapsedActiveMs: 70_000, recoverable: false });
  });

  it("11. the abort signal fires on expiry and cancels outstanding work", async () => {
    const { clock, advance } = fakeClock();
    const b = new ExecutionBudget({ ...clock, maximumMs: 10_000 });
    b.start();
    const signal = b.createAbortSignal();
    const work = new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason as Error)));
    advance(9_999);
    expect(signal.aborted).toBe(false);
    advance(1);
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBeInstanceOf(DynamicSkillsError);
    expect((signal.reason as DynamicSkillsError).info.category).toBe("sla_expired");
    await expect(work).rejects.toBeInstanceOf(DynamicSkillsError);
  });

  it("the abort countdown is suspended during a human pause and re-armed on resume", () => {
    const { clock, advance } = fakeClock();
    const b = new ExecutionBudget({ ...clock, maximumMs: 10_000 });
    b.start();
    const signal = b.createAbortSignal();
    advance(6_000);
    b.pause("human_clarification");
    advance(60_000);
    expect(signal.aborted).toBe(false);
    b.resume();
    advance(3_999);
    expect(signal.aborted).toBe(false);
    advance(1);
    expect(signal.aborted).toBe(true);
  });

  it("consume() re-arms the countdown; expired budgets yield already-aborted signals", () => {
    const { clock } = fakeClock();
    const b = new ExecutionBudget({ ...clock, maximumMs: 10_000 });
    const beforeStart = b.createAbortSignal();
    b.start();
    const signal = b.createAbortSignal();
    b.consume(10_000);
    expect(signal.aborted).toBe(true);
    expect(beforeStart.aborted).toBe(true);
    expect(b.createAbortSignal().aborted).toBe(true);
  });

  it("deadlineAt projects wall time + remaining budget", () => {
    const { clock, advance } = fakeClock();
    const b = new ExecutionBudget(clock);
    b.start();
    advance(15_000);
    expect(b.deadlineAt()).toBe(new Date(clock.wallNow() + 45_000).toISOString());
  });

  it("snapshot round-trips across processes on the same boot (time between processes counts while running)", () => {
    const { clock, advance } = fakeClock();
    const a = new ExecutionBudget(clock);
    a.start();
    advance(10_000);
    const snap = JSON.parse(JSON.stringify(a.snapshot())) as BudgetSnapshot;
    advance(5_000); // process A exits; process B starts later
    const b = ExecutionBudget.fromSnapshot(snap, clock);
    expect(b.consumedMs()).toBe(15_000);
    expect(b.isRunning()).toBe(true);
  });

  it("a paused snapshot stays paused across processes and keeps its round count", () => {
    const { clock, advance } = fakeClock();
    const a = new ExecutionBudget(clock);
    a.start();
    advance(8_000);
    a.pause("human_clarification");
    const snap = JSON.parse(JSON.stringify(a.snapshot())) as BudgetSnapshot;
    expect(snap).toMatchObject({ pauseReason: "human_clarification", roundsUsed: 1, consumedMs: 8_000 });
    expect(snap.activeSince).toBeUndefined();
    advance(3_600_000);
    const b = ExecutionBudget.fromSnapshot(snap, clock);
    expect(b.isPaused()).toBe(true);
    b.resume();
    advance(2_000);
    expect(b.consumedMs()).toBe(10_000);
    expect(b.roundsUsed).toBe(1);
  });

  it("falls back to wall-clock delta when the clock epoch changed (reboot), never negative", () => {
    const snap: BudgetSnapshot = {
      maximumMs: 60_000,
      consumedMs: 10_000,
      activeSince: 9_999_999, // monotonic stamp from the previous boot — meaningless now
      activeSinceWallMs: WALL0 + 1_000 - 7_000,
      roundsUsed: 1,
      maximumRounds: 3,
      clockEpoch: "boot-1000",
    };
    const { clock, advance } = fakeClock("boot-9000");
    const b = ExecutionBudget.fromSnapshot(snap, clock);
    expect(b.consumedMs()).toBe(17_000);
    expect(b.snapshot().clockEpoch).toBe("boot-9000");
    advance(1_000);
    expect(b.consumedMs()).toBe(18_000);

    const skewed = ExecutionBudget.fromSnapshot({ ...snap, activeSinceWallMs: WALL0 + 1_000_000 }, fakeClock("boot-9000").clock);
    expect(skewed.consumedMs()).toBe(10_000);

    const paused = ExecutionBudget.fromSnapshot(
      { ...snap, activeSince: undefined, activeSinceWallMs: undefined, pausedAt: 123, pauseReason: "human_clarification" },
      fakeClock("boot-9000").clock,
    );
    expect(paused.isPaused()).toBe(true);
    expect(paused.consumedMs()).toBe(10_000);
  });

  it("rejects malformed snapshots", () => {
    expect(() => ExecutionBudget.fromSnapshot({} as BudgetSnapshot)).toThrow(DynamicSkillsError);
  });
});
