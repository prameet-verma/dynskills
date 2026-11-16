/** Run `fn` over items with at most `limit` in flight; preserves input order in the result. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return results;
}

export class TimeoutError extends Error {
  constructor(readonly ms: number) {
    super(`Timed out after ${ms} ms`);
    this.name = "TimeoutError";
  }
}

/**
 * Run `fn` with a timeout. `fn` receives an AbortSignal that aborts on timeout or when the
 * parent signal aborts; the returned promise rejects with TimeoutError / the parent's reason.
 */
export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  ms: number,
  parent?: AbortSignal,
): Promise<T> {
  const ctrl = new AbortController();
  const onParentAbort = () => ctrl.abort(parent?.reason);
  if (parent?.aborted) throw parent.reason ?? new Error("Aborted");
  parent?.addEventListener("abort", onParentAbort, { once: true });
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      fn(ctrl.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const e = new TimeoutError(ms);
          ctrl.abort(e);
          reject(e);
        }, ms);
      }),
      new Promise<never>((_, reject) => {
        ctrl.signal.addEventListener("abort", () => reject(ctrl.signal.reason ?? new Error("Aborted")), { once: true });
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    parent?.removeEventListener("abort", onParentAbort);
  }
}
