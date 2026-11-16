import type { AnalysisEvidence, ContextPacket, DiscoveryEvidence } from "../contracts/index.js";
import { coverage, keywordSet } from "./text.js";

export interface KnownReferences {
  evidenceIds: Set<string>;
  paths: Set<string>;
}

/** Normalise a repository-relative path for comparison ("./src/a.ts" → "src/a.ts", no trailing slash). */
export function normalizeRefPath(p: string): string {
  return p.trim().replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
}

/** Evidence ids and repository-relative paths that a skill may cite, derived from the context packet. */
export function collectKnownReferences(packet: ContextPacket): KnownReferences {
  const evidenceIds = new Set(packet.evidence.map((e) => e.id));
  const paths = new Set<string>();
  const add = (p: string | undefined): void => {
    if (p === undefined) return;
    const n = normalizeRefPath(p);
    if (n !== "" && n !== ".") paths.add(n);
  };
  packet.evidence.forEach((e) => add(e.source));
  packet.instructions.forEach((i) => add(i.path));
  packet.configuration.forEach((c) => add(c.path));
  packet.sourceFiles.forEach((f) => add(f.path));
  packet.technology.frameworks.forEach((f) => add(f.source));
  packet.structure.entrypoints.forEach(add);
  packet.structure.relevantDirectories.forEach(add);
  packet.structure.workspaces.forEach(add);
  return { evidenceIds, paths };
}

export function isKnownRef(ref: string, known: KnownReferences, assumptionIds: ReadonlySet<string> = new Set()): boolean {
  return known.evidenceIds.has(ref) || assumptionIds.has(ref) || known.paths.has(normalizeRefPath(ref));
}

/** Minimum fraction of a statement's keywords that an evidence claim must contain to ground it. */
export const GROUNDING_MATCH_THRESHOLD = 0.6;

function matches(statement: string, claim: string): boolean {
  const a = statement.trim().toLowerCase();
  const b = claim.trim().toLowerCase();
  if (a.length > 0 && (a === b || b.includes(a) || a.includes(b))) return b.length > 0;
  return coverage(keywordSet(statement), keywordSet(claim)) >= GROUNDING_MATCH_THRESHOLD;
}

/**
 * Find citable references for a statement: sources of matching analysis evidence and ids of
 * matching packet evidence, restricted to references that are known to the packet.
 */
export function findGroundingRefs(
  statement: string,
  analysisEvidence: readonly AnalysisEvidence[],
  packetEvidence: readonly DiscoveryEvidence[],
  known: KnownReferences,
  limit = 3,
): string[] {
  const refs: string[] = [];
  const push = (r: string): void => {
    if (!refs.includes(r)) refs.push(r);
  };
  for (const e of analysisEvidence) {
    if (!matches(statement, e.claim)) continue;
    if (known.evidenceIds.has(e.source)) push(e.source);
    else if (known.paths.has(normalizeRefPath(e.source))) push(normalizeRefPath(e.source));
  }
  for (const e of packetEvidence) {
    if (matches(statement, e.claim)) push(e.id);
  }
  return refs.slice(0, limit);
}
