import type { CanonicalBundleRecord, ContextFingerprint, FreshnessDecision } from "../contracts/index.js";
import { MISSING_COMPONENT } from "./fingerprint.js";

/** repositoryId used by personal bundles that are valid in any repository. */
export const ANY_REPOSITORY = "*";

/** Fraction of changed components above which a skill is regenerated rather than augmented. */
export const REGENERATE_CHANGE_RATIO = 0.5;

export interface FreshnessOptions {
  /**
   * Repository-relative files whose change invalidates the skill's critical architectural
   * assumptions (§10.6 step 4). Changes to any other tracked file only trigger augmentation.
   */
  criticalFiles?: string[];
}

interface ParsedVersion {
  major: number;
  minor: number;
}

function parseVersion(v: string): ParsedVersion | undefined {
  const m = /(\d+)(?:\.(\d+|x|\*))?/.exec(v);
  if (!m) return undefined;
  const minor = m[2] !== undefined && /^\d+$/.test(m[2]) ? Number(m[2]) : 0;
  return { major: Number(m[1]), minor };
}

/** True when two fact values differ by a breaking version (major, or minor while on 0.x). Non-version values that differ are breaking. */
function isBreakingFactChange(prev: string, cur: string): boolean {
  const a = parseVersion(prev);
  const b = parseVersion(cur);
  if (!a || !b) return true;
  if (a.major !== b.major) return true;
  return a.major === 0 && a.minor !== b.minor;
}

const INACTIVE_STATUSES = new Set(["invalidated", "expired", "discarded"]);

/**
 * §10.6 freshness validation. Compares the stored fingerprint with the current one:
 * - different repository → regenerate (personal bundles with repositoryId "*" skip this check);
 * - identical fingerprint → reuse;
 * - only same-major fact changes / non-critical file edits / new components → augment;
 * - a tracked file now missing, a removed fact, a major version change, a critical file change,
 *   or more than 50% of components changed → regenerate.
 * The git revision is not part of the fingerprint, so a revision change alone never regenerates.
 */
export function assessFreshness(record: CanonicalBundleRecord, current: ContextFingerprint, options: FreshnessOptions = {}): FreshnessDecision {
  const prev = record.contextFingerprint;
  if (INACTIVE_STATUSES.has(record.lifecycleStatus)) {
    return { decision: "regenerate", reasons: [`Skill "${record.name}" is ${record.lifecycleStatus} and cannot be reused.`], changedComponents: [] };
  }
  const wildcard = record.repositoryId === ANY_REPOSITORY || prev.repositoryId === ANY_REPOSITORY;
  if (!wildcard && prev.repositoryId !== current.repositoryId) {
    return {
      decision: "regenerate",
      reasons: [`Skill "${record.name}" was generated for a different repository (${prev.repositoryId} ≠ ${current.repositoryId}).`],
      changedComponents: [],
    };
  }
  if (prev.overall === current.overall) {
    return { decision: "reuse", reasons: ["Relevant context is unchanged since the skill was generated."], changedComponents: [] };
  }

  const critical = new Set((options.criticalFiles ?? []).map((f) => `file:${f.replace(/^\.\//, "")}`));
  const keys = [...new Set([...Object.keys(prev.components), ...Object.keys(current.components)])].sort();
  const changed: string[] = [];
  const regenerateReasons: string[] = [];
  const augmentReasons: string[] = [];

  for (const key of keys) {
    const before = prev.components[key];
    const after = current.components[key];
    if (before === after) continue;
    changed.push(key);
    const isFile = key.startsWith("file:");
    const label = key.slice(key.indexOf(":") + 1);
    if (isFile) {
      if (after === MISSING_COMPONENT) regenerateReasons.push(`Dependent file ${label} is now missing.`);
      else if (after === undefined) augmentReasons.push(`Dependent file ${label} is no longer tracked.`);
      else if (before === undefined || before === MISSING_COMPONENT) augmentReasons.push(`Dependent file ${label} was added.`);
      else if (critical.has(key)) regenerateReasons.push(`Critical file ${label} changed.`);
      else augmentReasons.push(`File ${label} changed.`);
    } else {
      if (after === undefined) regenerateReasons.push(`Fact ${label} (${before}) no longer holds.`);
      else if (before === undefined) augmentReasons.push(`New fact ${label} = ${after}.`);
      else if (isBreakingFactChange(before, after)) regenerateReasons.push(`Fact ${label} changed incompatibly: ${before} → ${after}.`);
      else augmentReasons.push(`Fact ${label} changed compatibly: ${before} → ${after}.`);
    }
  }

  if (changed.length === 0) {
    // Same components but different overall hash: stored fingerprint is inconsistent; refresh it.
    return { decision: "augment", reasons: ["Stored fingerprint is inconsistent with its components; refresh the record."], changedComponents: [] };
  }
  const ratio = keys.length === 0 ? 1 : changed.length / keys.length;
  if (ratio > REGENERATE_CHANGE_RATIO) {
    regenerateReasons.push(`${changed.length} of ${keys.length} relevant context components changed (more than ${REGENERATE_CHANGE_RATIO * 100}%).`);
  }
  if (regenerateReasons.length > 0) return { decision: "regenerate", reasons: regenerateReasons, changedComponents: changed };
  return { decision: "augment", reasons: augmentReasons, changedComponents: changed };
}
