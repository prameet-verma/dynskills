import { describe, expect, it } from "vitest";
import type { DiscoveryEvidence } from "../../src/contracts/index.js";
import { evidenceId } from "../../src/core/index.js";
import { EvidenceRegistry, type EvidenceRegistrySnapshot } from "../../src/evidence-registry/index.js";

function ev(kind: DiscoveryEvidence["kind"], source: string, claim: string): DiscoveryEvidence {
  return { id: evidenceId("test", kind, source, claim), providerId: "test", kind, priority: "P0", claim, source, confidence: 1, value: { k: 1 } };
}

const A = ev("framework", "package.json", "Uses React 18.3.1");
const B = ev("runtime", ".nvmrc", "Node.js 20");
const C = ev("runtime", "package.json", "Node.js >=20");

describe("EvidenceRegistry", () => {
  it("stores, dedupes and indexes evidence", () => {
    const r = new EvidenceRegistry();
    r.add([A, B]);
    r.add(C);
    r.add({ ...A, claim: "different claim, same id" });
    expect(r.all()).toHaveLength(3);
    expect(r.get(A.id)?.claim).toBe("Uses React 18.3.1");
    expect(r.has(B.id)).toBe(true);
    expect(r.has("ev_missing")).toBe(false);
    expect(r.byKind("runtime").map((e) => e.id)).toEqual([B.id, C.id]);
    expect(r.bySource("./package.json").map((e) => e.id)).toEqual([A.id, C.id]);
    expect(r.sources()).toEqual(new Set(["package.json", ".nvmrc"]));
  });

  it("does not let callers mutate stored evidence", () => {
    const r = new EvidenceRegistry();
    const input = structuredClone(A);
    r.add(input);
    input.claim = "mutated";
    expect(r.get(A.id)?.claim).toBe("Uses React 18.3.1");
    expect(() => {
      (r.get(A.id) as DiscoveryEvidence).claim = "x";
    }).toThrow();
  });

  it("resolves evidence ids, known paths and registered paths", () => {
    const r = new EvidenceRegistry();
    r.add([A, B]);
    r.registerPath("src/payments/refund.ts");
    expect(r.resolveReference(A.id)).toEqual({ type: "evidence", evidence: A });
    expect(r.resolveReference("package.json")).toEqual({ type: "path", path: "package.json" });
    expect(r.resolveReference("./.nvmrc")).toEqual({ type: "path", path: ".nvmrc" });
    expect(r.resolveReference("src/payments/refund.ts:12")).toEqual({ type: "path", path: "src/payments/refund.ts" });
    expect(r.resolveReference("src/payments/refund.ts#L3-L9")).toEqual({ type: "path", path: "src/payments/refund.ts" });
    expect(r.resolveReference("src/unknown.ts")).toBeUndefined();
    expect(r.resolveReference("ev_000000000000")).toBeUndefined();
    expect(r.sources()).toContain("src/payments/refund.ts");
    expect(() => r.registerPath("../outside.ts")).toThrow();
    expect(() => r.registerPath("/etc/passwd")).toThrow();
  });

  it("retains provenance and never relabels inferences as observations", () => {
    const r = new EvidenceRegistry();
    r.add(A);
    r.recordClaim({ claim: "Uses React", source: A.id, classification: "observed", origin: "analysis" });
    r.recordClaim({ claim: "Feature-sliced architecture", source: "src/nowhere", classification: "observed", origin: "analysis" });
    r.recordClaim({ claim: "Uses hooks everywhere", source: "package.json", classification: "inferred", origin: "analysis" });
    r.recordClaim({ claim: "Uses hooks everywhere", source: "package.json", classification: "observed", origin: "analysis" });
    r.recordClaim({ claim: "Payments are idempotent", source: "asm_1", classification: "observed", origin: "assumption" });
    r.recordClaim({ claim: "Node version", source: "package.json", classification: "observed", origin: "discovery" });
    r.recordClaim({ claim: "Node version", source: "package.json", classification: "conflicting", origin: "discovery" });
    const claims = r.claims();
    expect(claims.map((c) => [c.claim, c.classification, c.sourceType])).toEqual([
      ["Uses React", "observed", "evidence"],
      ["Feature-sliced architecture", "inferred", "unresolved"],
      ["Uses hooks everywhere", "inferred", "path"],
      ["Payments are idempotent", "assumed", "unresolved"],
      ["Node version", "conflicting", "path"],
    ]);
    expect(claims[1]?.requestedClassification).toBe("observed");
    expect(claims.every((c) => c.origin)).toBe(true);
  });

  it("round-trips through JSON and re-validates restored claims", () => {
    const r = new EvidenceRegistry();
    r.add([A, B, C]);
    r.registerPath("src/a.ts");
    r.recordClaim({ claim: "Uses React", source: A.id, classification: "observed", origin: "analysis" });
    r.recordClaim({ claim: "Guess", source: "nowhere", classification: "observed", origin: "analysis" });
    const snap = JSON.parse(JSON.stringify(r.toJSON())) as EvidenceRegistrySnapshot;
    const restored = EvidenceRegistry.fromJSON(snap);
    expect(restored.toJSON()).toEqual(r.toJSON());
    expect(restored.resolveReference("src/a.ts")).toEqual({ type: "path", path: "src/a.ts" });
    expect(restored.resolveReference(B.id)?.type).toBe("evidence");

    const tampered: EvidenceRegistrySnapshot = {
      ...snap,
      claims: [{ claim: "Smuggled", source: "nowhere", classification: "observed", origin: "analysis", sourceType: "evidence" }],
    };
    expect(EvidenceRegistry.fromJSON(tampered).claims()[0]).toMatchObject({ classification: "inferred", sourceType: "unresolved", requestedClassification: "observed" });
    expect(() => EvidenceRegistry.fromJSON({} as EvidenceRegistrySnapshot)).toThrow();
  });
});
