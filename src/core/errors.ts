import type { ComponentId, ErrorCategory, ErrorInfo } from "../contracts/index.js";

/** §17: every failure carries runId, category, component, elapsed active time, recoverability and fallback. */
export class DynamicSkillsError extends Error {
  readonly info: ErrorInfo;

  constructor(info: ErrorInfo, options?: { cause?: unknown }) {
    super(info.message, options);
    this.name = "DynamicSkillsError";
    this.info = info;
  }

  toJSON(): ErrorInfo {
    return { ...this.info };
  }
}

export function dsError(
  category: ErrorCategory,
  component: ComponentId,
  message: string,
  opts: Partial<Omit<ErrorInfo, "category" | "component" | "message">> & { cause?: unknown } = {},
): DynamicSkillsError {
  const { cause, ...rest } = opts;
  return new DynamicSkillsError(
    {
      category,
      component,
      message,
      recoverable: rest.recoverable ?? false,
      fallbackAction: rest.fallbackAction ?? "Return control to the root agent and continue with existing capabilities.",
      ...(rest.runId !== undefined ? { runId: rest.runId } : {}),
      ...(rest.elapsedActiveMs !== undefined ? { elapsedActiveMs: rest.elapsedActiveMs } : {}),
    },
    cause !== undefined ? { cause } : undefined,
  );
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
