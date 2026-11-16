import { createHash } from "node:crypto";
import type { SkillFile } from "../contracts/index.js";

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** JSON.stringify with recursively sorted object keys (stable across runs). */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/** Artifact hash: sha256 over files sorted by path, framed to avoid ambiguity. */
export function hashSkillFiles(files: readonly SkillFile[]): string {
  const h = createHash("sha256");
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    h.update(`${f.path.length}:${f.path}\n${Buffer.byteLength(f.content)}:`);
    h.update(f.content);
    h.update("\n");
  }
  return h.digest("hex");
}

/** Deterministic evidence id: "ev_" + 12 hex chars. */
export function evidenceId(providerId: string, kind: string, source: string, claim: string): string {
  return `ev_${sha256(`${providerId}|${kind}|${source}|${claim}`).slice(0, 12)}`;
}
