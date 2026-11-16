import { uptime } from "node:os";

/**
 * Monotonic milliseconds. process.hrtime is backed by the OS monotonic clock
 * (mach_absolute_time on macOS, CLOCK_MONOTONIC on Linux), which counts from boot and
 * is therefore comparable across processes on the same machine until reboot.
 */
export function monotonicNowMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

/**
 * Identifies the current boot so persisted monotonic timestamps can be checked for comparability.
 * Boot time is rounded to 10 s to absorb uptime jitter.
 */
export function clockEpoch(): string {
  const bootSeconds = Math.round((Date.now() / 1000 - uptime()) / 10) * 10;
  return `boot-${bootSeconds}`;
}

/** Tolerant comparison: two epochs within one rounding bucket refer to the same boot. */
export function sameClockEpoch(a: string, b: string): boolean {
  const pa = Number(a.replace("boot-", ""));
  const pb = Number(b.replace("boot-", ""));
  return Number.isFinite(pa) && Number.isFinite(pb) && Math.abs(pa - pb) <= 10;
}

export function isoNow(): string {
  return new Date().toISOString();
}

/** Simple stopwatch for durationMs fields. */
export function stopwatch(): () => number {
  const start = monotonicNowMs();
  return () => monotonicNowMs() - start;
}
