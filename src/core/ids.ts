import { randomUUID } from "node:crypto";

/** Short random id with a prefix, e.g. newId("run") → "run_3f9c1a2b7d4e". */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}
