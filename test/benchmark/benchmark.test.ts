import { describe, it, expect } from "vitest";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Orchestrator } from "../../src/orchestrator/index.js";
import { validateContextAnalysisResult } from "../../src/context-analyzer-contracts/index.js";
import type { ContextPacket } from "../../src/contracts/index.js";
import {
  DEFAULT_FIXTURES_ROOT,
  DEFAULT_SCENARIOS_PATH,
  discoveryAccuracy,
  formatBenchmarkTable,
  loadScenarios,
  percentile,
  runBenchmarks,
  standInAnalysis,
} from "../../src/benchmark/index.js";

const FIXTURES = [
  "node-ts-monorepo",
  "python-project",
  "java-microservices",
  "go-service",
  "mixed-language",
  "conflicting-runtime",
  "minimal-docs",
  "extensive-instructions",
];

async function packetFor(fixture: string): Promise<ContextPacket> {
  const root = await mkdtemp(path.join(tmpdir(), "ds-bench-test-"));
  const home = await mkdtemp(path.join(tmpdir(), "ds-bench-test-home-"));
  try {
    await cp(path.join(DEFAULT_FIXTURES_ROOT, fixture), root, { recursive: true });
    const orch = new Orchestrator({ root, harness: "claude", homeDir: home, sessionId: "sess_bench", env: { PATH: "" } });
    const res = await orch.start({ task: { description: "Add a small feature with tests" }, forceGenerate: true });
    expect(res.status).toBe("awaiting_analysis");
    return JSON.parse(await readFile(res.packetPath as string, "utf8")) as ContextPacket;
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
}

const TWO = ["node-ts-refund-route", "go-readiness-handler"];

describe("benchmark scenarios", () => {
  it("has at least 10 scenarios covering every fixture", async () => {
    const scenarios = await loadScenarios();
    expect(existsSync(DEFAULT_SCENARIOS_PATH)).toBe(true);
    expect(scenarios.length).toBeGreaterThanOrEqual(10);
    expect(new Set(scenarios.map((s) => s.fixture))).toEqual(new Set(FIXTURES));
    for (const s of scenarios) expect(existsSync(path.join(DEFAULT_FIXTURES_ROOT, s.fixture))).toBe(true);
  });
});

describe("standInAnalysis", () => {
  it.each(FIXTURES)("produces a valid ContextAnalysisResult for %s", async (fixture) => {
    const packet = await packetFor(fixture);
    const analysis = standInAnalysis(packet);
    const outcome = validateContextAnalysisResult(analysis, packet);
    expect(outcome.issues.filter((i) => i.severity === "error"), JSON.stringify(outcome.issues)).toEqual([]);
    expect(outcome.valid).toBe(true);
    expect(analysis.runId).toBe(packet.runId);
    expect(analysis.technology.languages).toEqual(packet.technology.languages);
    expect(standInAnalysis(packet)).toEqual(analysis); // deterministic
  });

  it("turns instruction lines into conventions and runtime disagreements into conflicts", async () => {
    const instr = standInAnalysis(await packetFor("extensive-instructions"));
    expect(instr.architecture.conventions).toContain("Use 2-space indentation.");
    expect(instr.evidence.some((e) => e.source === "AGENTS.md" && e.type === "observed")).toBe(true);
    const conflicting = standInAnalysis(await packetFor("conflicting-runtime"));
    expect(conflicting.conflicts).toHaveLength(1);
    expect(conflicting.conflicts[0]?.observations.length).toBeGreaterThanOrEqual(2);
    // "20.11.1 (.nvmrc) | >=20 (package.json)" is compatible, not a conflict.
    expect(standInAnalysis(await packetFor("node-ts-monorepo")).conflicts).toEqual([]);
  });
});

describe("runBenchmarks", () => {
  it("runs scenarios end to end and populates every metric", async () => {
    const report = await runBenchmarks({ scenarioIds: TWO });
    expect(report.scenarios.map((s) => s.id)).toEqual(TWO);
    expect(report.environment.hostLatencyMs).toBe(0);
    for (const r of report.scenarios) {
      expect(r.error).toBeUndefined();
      expect(r.finalStatus).toBe("active");
      expect(r.activated).toBe(true);
      expect(r.timedOut).toBe(false);
      for (const key of ["activeMs", "discoveryMs", "compilationMs", "evaluationMs", "activationMs", "packetTokens", "packetFiles", "skillTokens"] as const) {
        expect(typeof r[key], key).toBe("number");
        expect(r[key] as number, key).toBeGreaterThanOrEqual(0);
      }
      expect(r.packetTokens).toBeGreaterThan(0);
      expect(r.skillTokens).toBeGreaterThan(0);
      expect(r.hostTurns).toBeGreaterThanOrEqual(2);
      expect(r.bridgeCalls).toBeGreaterThanOrEqual(3);
      expect(r.accuracy.overall).toBeGreaterThanOrEqual(0);
      expect(r.accuracy.overall).toBeLessThanOrEqual(1);
      expect(r.slaViolated).toBe(false);
    }
    expect(report.summary.count).toBe(2);
    expect(report.summary.activated).toBe(2);
    expect(report.summary.timeoutRate).toBe(0);
    expect(report.summary.slaViolations).toEqual([]);
    expect(report.summary.meanRecall).toBeGreaterThan(0);
    expect(report.summary.meanRecall).toBeLessThanOrEqual(1);
    expect(report.summary.activeMs.max).toBeGreaterThanOrEqual(report.summary.activeMs.p50);

    const table = formatBenchmarkTable(report);
    for (const id of TWO) expect(table).toContain(id);
    expect(table).toMatch(/SLA violations: none/);
  });

  it("counts simulated host latency against active time", async () => {
    const latency = 30;
    const [base, slow] = [await runBenchmarks({ scenarioIds: ["go-readiness-handler"] }), await runBenchmarks({ scenarioIds: ["go-readiness-handler"], hostLatencyMs: latency })];
    const b = base.scenarios[0];
    const s = slow.scenarios[0];
    expect(b?.activated && s?.activated).toBe(true);
    expect(slow.environment.hostLatencyMs).toBe(latency);
    // One host turn before analyze and one before compile → at least 2 × latency of extra SLA time.
    expect(s?.hostTurns).toBe(2);
    expect(s?.activeMs ?? 0).toBeGreaterThanOrEqual((s?.hostTurns ?? 0) * latency);
    expect((s?.activeMs ?? 0) - (b?.activeMs ?? 0)).toBeGreaterThanOrEqual(latency);
  });

  it("rejects unknown scenario ids", async () => {
    await expect(runBenchmarks({ scenarioIds: ["nope"] })).rejects.toThrow(/nope/);
  });
});

describe("helpers", () => {
  it("computes recall per category, ignoring categories with nothing expected", () => {
    const packet = {
      technology: { languages: ["TypeScript"], frameworks: [{ name: "Express", source: "package.json" }], packageManagers: ["pnpm"], runtimes: {}, tooling: [] },
      instructions: [{ path: "CLAUDE.md" }],
    } as unknown as ContextPacket;
    const acc = discoveryAccuracy({ languages: ["typescript"], frameworks: ["Express", "Zod"], packageManagers: [], instructions: ["CLAUDE.md"] }, packet);
    expect(acc.languages).toBe(1);
    expect(acc.frameworks).toBe(0.5);
    expect(acc.packageManagers).toBeNull();
    expect(acc.overall).toBe(0.75);
    expect(acc.missed).toEqual(["frameworks:Zod"]);
    expect(discoveryAccuracy({ languages: ["Go"], frameworks: [], packageManagers: [] }, undefined).overall).toBe(0);
  });

  it("uses nearest-rank percentiles", () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([5, 1, 3], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
  });
});
