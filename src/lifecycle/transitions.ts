import type { CanonicalBundleRecord, LifecycleStatus } from "../contracts/index.js";
import { dsError } from "../core/index.js";
import { ANY_REPOSITORY } from "./freshness.js";

/**
 * Skill lifecycle transitions (§10). Self-transitions are idempotent no-ops.
 *
 * | from        | allowed to                                         |
 * |-------------|----------------------------------------------------|
 * | ephemeral   | active, discarded, expired                         |
 * | active      | persisted, ephemeral, discarded, invalidated       |
 * | persisted   | active, invalidated, expired, discarded            |
 * | invalidated | discarded, active (after regeneration)             |
 * | expired     | discarded                                          |
 * | discarded   | (terminal)                                         |
 */
export const LIFECYCLE_TRANSITIONS: Readonly<Record<LifecycleStatus, readonly LifecycleStatus[]>> = {
  ephemeral: ["active", "discarded", "expired"],
  active: ["persisted", "ephemeral", "discarded", "invalidated"],
  persisted: ["active", "invalidated", "expired", "discarded"],
  invalidated: ["discarded", "active"],
  expired: ["discarded"],
  discarded: [],
};

export function canTransitionLifecycle(from: LifecycleStatus, to: LifecycleStatus): boolean {
  return from === to || (LIFECYCLE_TRANSITIONS[from]?.includes(to) ?? false);
}

export function transitionLifecycle(from: LifecycleStatus, to: LifecycleStatus): LifecycleStatus {
  if (!canTransitionLifecycle(from, to)) {
    throw dsError("invalid_state", "lifecycle", `Illegal lifecycle transition: ${from} → ${to}`, {
      recoverable: true,
      fallbackAction: `Allowed from ${from}: ${LIFECYCLE_TRANSITIONS[from].join(", ") || "none (terminal)"}.`,
    });
  }
  return to;
}

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

/** Next semantic version of a skill; undefined → "1.0.0". */
export function nextSkillVersion(prev: string | undefined, change: "patch" | "minor" | "major"): string {
  if (prev === undefined) return "1.0.0";
  const m = SEMVER_RE.exec(prev.trim().replace(/^v/, ""));
  if (!m) throw dsError("invalid_state", "lifecycle", `Invalid skill version: ${JSON.stringify(prev)}`, { recoverable: true, fallbackAction: "Reset the version to 1.0.0." });
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (change === "major") return `${major + 1}.0.0`;
  if (change === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "onto", "use", "using", "when", "add", "make", "new",
  "our", "your", "are", "was", "will", "should", "can", "all", "any", "not", "but", "how", "what", "about", "please",
]);

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
      .map((t) => (t.length > 4 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t)),
  );
}

/**
 * Candidate bundles for reuse (§4 REUSE_EXISTING): same repository (or personal bundles with
 * repositoryId "*"), status persisted/active, scored by lexical overlap between the task and the
 * bundle's name (weighted ×2) and original task. Returned best first; zero-score bundles excluded.
 */
export function findReusableBundles(input: { taskDescription: string; bundles: CanonicalBundleRecord[]; repositoryId: string }): CanonicalBundleRecord[] {
  const taskTokens = tokenize(input.taskDescription);
  if (taskTokens.size === 0) return [];
  const scored: Array<{ rec: CanonicalBundleRecord; score: number }> = [];
  for (const rec of input.bundles) {
    if (rec.repositoryId !== input.repositoryId && rec.repositoryId !== ANY_REPOSITORY) continue;
    if (rec.lifecycleStatus !== "persisted" && rec.lifecycleStatus !== "active") continue;
    const nameTokens = tokenize(rec.name);
    const bodyTokens = tokenize(rec.task ?? "");
    let score = 0;
    for (const t of taskTokens) {
      if (nameTokens.has(t)) score += 2;
      if (bodyTokens.has(t)) score += 1;
    }
    if (score === 0) continue;
    const normalized = score / Math.sqrt(nameTokens.size + bodyTokens.size || 1);
    scored.push({ rec, score: normalized });
  }
  return scored
    .sort((a, b) => b.score - a.score || (b.rec.updatedAt ?? "").localeCompare(a.rec.updatedAt ?? "") || a.rec.name.localeCompare(b.rec.name))
    .map((s) => s.rec);
}
