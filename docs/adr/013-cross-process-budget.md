# ADR-013: The active-processing budget uses the OS monotonic clock across processes

> The budget was 60 seconds when this was written; [ADR-018](018-two-minute-budget.md) raised it to 120 seconds.

**Status:** Accepted

## Context

§6.4 requires a monotonic clock, not wall-clock time, for elapsed active time. With the CLI bridge (ADR-012), one run spans many processes, and time between commands counts, because that is the host LLM working. The only exception is a human clarification pause.

## Decision

`process.hrtime` is backed by `mach_absolute_time` on macOS and `CLOCK_MONOTONIC` on Linux. Both count from boot, so their values can be compared across processes on the same machine.

- The budget snapshot stores the monotonic start of the current active segment, plus a boot identifier: boot time rounded to 10 s.
- If the boot identifier no longer matches after a reboot, the budget falls back to the wall-clock delta recorded alongside it, and never counts negative time.

## Consequences

- Active time is correct across commands, pauses and resumes.
- A reboot in the middle of a run falls back to wall-clock time for the open segment. That is an accepted edge case.
