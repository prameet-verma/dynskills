import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { DiscoveryContext, DiscoveryEvidence, DiscoveryPriority, DiscoveryProvider } from "../../src/contracts/index.js";
import { evidenceId } from "../../src/core/index.js";
import { buildFileIndex, createDefaultProviders, RepositoryScanner } from "../../src/discovery/index.js";
import { fixture, fixtureCopyWithExclusions, LIMITS, TASK, tmpDir } from "./helpers.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mkEvidence(providerId: string, claim: string, priority: DiscoveryPriority = "P0", kind: DiscoveryEvidence["kind"] = "tooling"): DiscoveryEvidence {
  return { id: evidenceId(providerId, kind, ".", claim), providerId, kind, priority, claim, source: ".", confidence: 1 };
}

function fake(
  id: string,
  run: (ctx: DiscoveryContext, signal?: AbortSignal) => Promise<DiscoveryEvidence[]>,
  priority: DiscoveryPriority = "P0",
  supports: boolean | (() => boolean) = true,
): DiscoveryProvider {
  return { id, priority, supports: typeof supports === "function" ? supports : () => supports, discover: run };
}

describe("buildFileIndex", () => {
  it("excludes sensitive files and default-excluded directories, sorted POSIX paths", async () => {
    const root = await fixtureCopyWithExclusions("node-ts-monorepo");
    const index = await buildFileIndex(root);
    expect(index).toContain("packages/api/src/routes/payments.ts");
    expect(index).toContain("CLAUDE.md");
    expect(index.some((p) => p.includes("node_modules"))).toBe(false);
    expect(index.some((p) => p.startsWith("dist/"))).toBe(false);
    expect(index.some((p) => /(^|\/)\.env/.test(p))).toBe(false);
    expect(index).not.toContain("server.pem");
    expect(index).toEqual([...index].sort());
    expect(index.every((p) => !p.includes("\\") && !path.isAbsolute(p))).toBe(true);
  });

  it("caps entries, keeping shallow files", async () => {
    const index = await buildFileIndex(fixture("node-ts-monorepo"), { maxEntries: 5 });
    expect(index).toHaveLength(5);
    expect(index.every((p) => !p.includes("/"))).toBe(true);
  });

  it("does not follow symlinks", async () => {
    const root = await tmpDir();
    const outside = await tmpDir();
    await writeFile(path.join(outside, "secret.ts"), "export const x = 1;\n");
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "a.ts"), "export {};\n");
    await symlink(outside, path.join(root, "linked"));
    await symlink(path.join(outside, "secret.ts"), path.join(root, "src", "link.ts"));
    const index = await buildFileIndex(root);
    expect(index).toEqual(["src/a.ts"]);
  });
});

describe("RepositoryScanner", () => {
  it("isolates a throwing provider and a timed-out provider; others still contribute", async () => {
    let slowSignal: AbortSignal | undefined;
    const providers = [
      fake("good", async () => [mkEvidence("good", "good fact")]),
      fake("throws", async () => {
        throw new Error("boom");
      }),
      fake("slow", async (_ctx, signal) => {
        slowSignal = signal;
        await sleep(500);
        return [mkEvidence("slow", "late fact")];
      }),
      fake("sync-throw-supports", async () => [], "P0", () => {
        throw new Error("supports failed");
      }),
    ];
    const report = await new RepositoryScanner(providers).scan({ root: fixture("minimal-docs"), task: TASK, limits: { ...LIMITS, providerTimeoutMs: 50 } });
    const status = Object.fromEntries(report.providers.map((p) => [p.providerId, p.status]));
    expect(status).toEqual({ good: "ok", throws: "error", slow: "timeout", "sync-throw-supports": "error" });
    expect(report.providers.find((p) => p.providerId === "throws")?.error).toContain("boom");
    expect(report.evidence.map((e) => e.claim)).toEqual(["good fact"]);
    expect(slowSignal?.aborted).toBe(true);
    expect(report.durationMs).toBeLessThan(450);
  });

  it("bounds provider concurrency", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const providers = Array.from({ length: 7 }, (_, i) =>
      fake(`p${i}`, async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await sleep(25);
        inFlight--;
        return [mkEvidence(`p${i}`, `fact ${i}`)];
      }),
    );
    const report = await new RepositoryScanner(providers).scan({ root: fixture("minimal-docs"), task: TASK, limits: { ...LIMITS, concurrency: 2 } });
    expect(maxInFlight).toBe(2);
    expect(report.evidence).toHaveLength(7);
  });

  it("respects maxPriority and supports(), and dedupes evidence by id with deterministic order", async () => {
    const shared = mkEvidence("x", "same fact");
    const providers = [
      fake("b", async () => [shared, mkEvidence("b", "zeta", "P0", "language")]),
      fake("a", async () => [shared]),
      fake("p1", async () => [mkEvidence("p1", "p1 fact", "P1")], "P1"),
      fake("p2", async () => [mkEvidence("p2", "p2 fact", "P2")], "P2"),
      fake("unsupported", async () => [mkEvidence("u", "never")], "P0", false),
    ];
    const scanner = new RepositoryScanner(providers);
    const r1 = await scanner.scan({ root: fixture("minimal-docs"), task: TASK, limits: LIMITS });
    expect(r1.evidence.map((e) => e.claim)).toEqual(["zeta", "same fact", "p1 fact"]);
    const status = Object.fromEntries(r1.providers.map((p) => [p.providerId, p.status]));
    expect(status).toMatchObject({ p1: "ok", p2: "skipped", unsupported: "skipped" });
    const r0 = await scanner.scan({ root: fixture("minimal-docs"), task: TASK, limits: LIMITS, maxPriority: "P0" });
    expect(r0.evidence.map((e) => e.claim)).toEqual(["zeta", "same fact"]);
  });

  it("propagates a parent abort signal", async () => {
    const ctrl = new AbortController();
    ctrl.abort(new Error("cancelled"));
    const report = await new RepositoryScanner([fake("a", async () => [mkEvidence("a", "x")])]).scan({ root: fixture("minimal-docs"), task: TASK, limits: LIMITS, signal: ctrl.signal });
    expect(report.providers[0]?.status).toBe("error");
    expect(report.evidence).toHaveLength(0);
  });

  it("shares one file index with every provider and never surfaces excluded files", async () => {
    const root = await fixtureCopyWithExclusions("node-ts-monorepo");
    const seen: number[] = [];
    const spy = fake("spy", async (ctx) => {
      seen.push(ctx.fileIndex.length);
      return [];
    });
    const report = await new RepositoryScanner([...createDefaultProviders(), spy]).scan({ root, task: TASK, limits: LIMITS });
    expect(seen).toEqual([report.fileIndexSize]);
    expect(report.evidence.some((e) => /node_modules|(^|\/)dist\/|\.env|\.pem$/.test(e.source))).toBe(false);
  });

  it("provides one default provider per scanner with the specified ids and priorities", () => {
    const ids = Object.fromEntries(createDefaultProviders().map((p) => [p.id, p.priority]));
    expect(ids).toEqual({
      filesystem: "P0",
      manifest: "P0",
      runtime: "P0",
      framework: "P0",
      "package-manager": "P0",
      monorepo: "P0",
      "test-config": "P0",
      "build-config": "P0",
      instructions: "P0",
      "existing-skills": "P0",
      cicd: "P1",
      documentation: "P1",
      "source-files": "P1",
    });
  });
});
