/**
 * Evidence storage and provenance (§5.4 evidence distinction, §12.2 evidence-registry).
 * Holds discovery evidence, known repository paths and classified claims. Claims keep their origin;
 * an inference is never relabelled as an observation.
 */
import type { DiscoveryEvidence, EvidenceClassification, EvidenceKind, SchemaVersion } from "../contracts/index.js";
import { SCHEMA_VERSION } from "../contracts/index.js";
import { dsError, toPosix } from "../core/index.js";

export type ClaimOrigin = "discovery" | "analysis" | "clarification" | "assumption";

export interface ClaimInput {
  claim: string;
  source: string;
  classification: EvidenceClassification;
  origin: ClaimOrigin;
}

export interface ClaimRecord extends ClaimInput {
  /** How `source` resolved against the registry when the claim was recorded. */
  sourceType: "evidence" | "path" | "unresolved";
  /** Set when the requested classification was not accepted as-is (e.g. "observed" without resolvable evidence). */
  requestedClassification?: EvidenceClassification;
  note?: string;
}

export interface EvidenceRegistrySnapshot {
  schemaVersion: SchemaVersion;
  evidence: DiscoveryEvidence[];
  /** Additional repository-relative paths registered as referenceable (e.g. packet file paths). */
  paths: string[];
  claims: ClaimRecord[];
}

export type ResolvedReference = { type: "evidence"; evidence: DiscoveryEvidence } | { type: "path"; path: string };

function normalizePath(p: string): string {
  let s = toPosix(p.trim()).replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (s === "") s = ".";
  return s;
}

function clone<T>(v: T): T {
  return structuredClone(v);
}

export class EvidenceRegistry {
  private readonly evidence = new Map<string, DiscoveryEvidence>();
  private readonly sourceIndex = new Map<string, DiscoveryEvidence[]>();
  private readonly paths = new Set<string>();
  private readonly claimList: ClaimRecord[] = [];
  private readonly claimIndex = new Map<string, number>();

  /** Add evidence; the first entry for an id wins (deterministic ids make duplicates identical). */
  add(e: DiscoveryEvidence | DiscoveryEvidence[]): void {
    for (const item of Array.isArray(e) ? e : [e]) {
      if (this.evidence.has(item.id)) continue;
      const stored = Object.freeze(clone(item));
      this.evidence.set(item.id, stored);
      const src = normalizePath(item.source);
      const list = this.sourceIndex.get(src);
      if (list) list.push(stored);
      else this.sourceIndex.set(src, [stored]);
    }
  }

  get(id: string): DiscoveryEvidence | undefined {
    return this.evidence.get(id);
  }

  has(id: string): boolean {
    return this.evidence.has(id);
  }

  all(): DiscoveryEvidence[] {
    return [...this.evidence.values()];
  }

  byKind(kind: EvidenceKind): DiscoveryEvidence[] {
    return this.all().filter((e) => e.kind === kind);
  }

  bySource(p: string): DiscoveryEvidence[] {
    return [...(this.sourceIndex.get(normalizePath(p)) ?? [])];
  }

  /** All referenceable repository paths: evidence sources plus registered paths. */
  sources(): Set<string> {
    return new Set([...this.sourceIndex.keys(), ...this.paths]);
  }

  /** Register a repository-relative path (e.g. a file included in the context packet) as referenceable. */
  registerPath(p: string): void {
    const n = normalizePath(p);
    if (n.startsWith("../") || n === ".." || n.startsWith("/") || /^[A-Za-z]:\//.test(n)) {
      throw dsError("security", "evidence-registry", `Refusing to register a path outside the repository: ${p}`, {
        recoverable: true,
        fallbackAction: "Register repository-relative paths only.",
      });
    }
    this.paths.add(n);
  }

  /** Resolve an evidence id or a known repository-relative path. */
  resolveReference(ref: string): ResolvedReference | undefined {
    const trimmed = ref.trim();
    const ev = this.evidence.get(trimmed);
    if (ev) return { type: "evidence", evidence: ev };
    const p = normalizePath(trimmed);
    if (this.sourceIndex.has(p) || this.paths.has(p)) return { type: "path", path: p };
    // "path:line" or "path#L10" style references to a known path.
    const stripped = p.replace(/(#L\d+(-L?\d+)?|:\d+(-\d+)?)$/, "");
    if (stripped !== p && (this.sourceIndex.has(stripped) || this.paths.has(stripped))) return { type: "path", path: stripped };
    return undefined;
  }

  /**
   * Record a classified claim with provenance.
   * - "observed" requires a source that resolves to registry evidence or a known path, and an origin
   *   that can observe (discovery/analysis/clarification); otherwise it is downgraded ("inferred",
   *   or "assumed" for assumptions) and the requested label is kept in `requestedClassification`.
   * - Re-recording the same claim/source/origin never upgrades a non-observed claim to "observed";
   *   "conflicting" is the only classification that may replace an earlier one.
   */
  recordClaim(c: ClaimInput): void {
    const resolved = this.resolveReference(c.source);
    const sourceType: ClaimRecord["sourceType"] = resolved?.type ?? "unresolved";
    let classification = c.classification;
    let note: string | undefined;
    if (c.origin === "assumption" && classification === "observed") {
      classification = "assumed";
      note = "assumptions cannot be observed facts";
    } else if (classification === "observed" && !resolved) {
      classification = "inferred";
      note = "observed claim without resolvable evidence was downgraded";
    }
    const record: ClaimRecord = {
      claim: c.claim,
      source: c.source,
      classification,
      origin: c.origin,
      sourceType,
      ...(classification !== c.classification ? { requestedClassification: c.classification } : {}),
      ...(note ? { note } : {}),
    };
    const key = `${c.origin}\u0000${c.source}\u0000${c.claim}`;
    const existingIdx = this.claimIndex.get(key);
    if (existingIdx === undefined) {
      this.claimIndex.set(key, this.claimList.length);
      this.claimList.push(Object.freeze(record));
      return;
    }
    const existing = this.claimList[existingIdx] as ClaimRecord;
    if (record.classification === "conflicting" && existing.classification !== "conflicting") {
      this.claimList[existingIdx] = Object.freeze({ ...record, note: `previously ${existing.classification}` });
    }
    // Otherwise keep the first record: never relabel (in particular, never inferred → observed).
  }

  claims(): ClaimRecord[] {
    return this.claimList.map((c) => ({ ...c }));
  }

  toJSON(): EvidenceRegistrySnapshot {
    return {
      schemaVersion: SCHEMA_VERSION,
      evidence: this.all().map(clone),
      paths: [...this.paths].sort(),
      claims: this.claims(),
    };
  }

  static fromJSON(s: EvidenceRegistrySnapshot): EvidenceRegistry {
    if (!s || typeof s !== "object" || !Array.isArray(s.evidence)) {
      throw dsError("schema", "evidence-registry", "Invalid evidence registry snapshot", { recoverable: false });
    }
    const r = new EvidenceRegistry();
    r.add(s.evidence);
    for (const p of s.paths ?? []) r.registerPath(p);
    // Re-validate restored claims: a snapshot can never smuggle in an unsupported "observed" label.
    for (const c of s.claims ?? []) {
      r.recordClaim({ claim: c.claim, source: c.source, classification: c.classification, origin: c.origin });
      const idx = r.claimIndex.get(`${c.origin}\u0000${c.source}\u0000${c.claim}`);
      const stored = idx === undefined ? undefined : r.claimList[idx];
      if (stored && idx !== undefined && c.requestedClassification && !stored.requestedClassification) {
        r.claimList[idx] = Object.freeze({ ...stored, requestedClassification: c.requestedClassification, ...(c.note ? { note: c.note } : {}) });
      }
    }
    return r;
  }
}
