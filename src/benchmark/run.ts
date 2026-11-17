import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import type { ClarificationRequest, ContextPacket, HarnessId } from "../contracts/index.js";
import { errorMessage, isoNow, stopwatch } from "../core/index.js";
import { Orchestrator, type BridgeResponse, type RunMetrics } from "../orchestrator/index.js";
import { standInAnalysis } from "./stand-in-host.js";

/** §15.1 / ADR-007: hard active-processing budget, checked per scenario end to end. */
export const SLA_MS = 60_000;

/** Upper bound on bridge commands per scenario (start + analyze/clarify/compile loops). */
const MAX_BRIDGE_STEPS = 16;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExpectedContext {
  languages: string[];
  frameworks: string[];
  packageManagers: string[];
  /** Repository-relative instruction files discovery should surface (e.g. `CLAUDE.md`). */
  instructions?: string[];
}

export interface BenchmarkScenario {
  id: string;
  /** Directory name under `fixtures/`. */
  fixture: string;
  task: string;
  expected: ExpectedContext;
}

export interface BenchmarkOptions {
  /** Defaults to `benchmarks/scenarios.json` in the package root. */
  scenariosPath?: string;
  /** Defaults to `fixtures/` in the package root. */
  fixturesRoot?: string;
  /** Simulated host LLM latency before each host submission (analyze, compile). Counts against the SLA. Default 0. */
  hostLatencyMs?: number;
  /** Run only these scenario ids (in file order). */
  scenarioIds?: string[];
  /** Default `claude`. */
  harness?: HarnessId;
}

/** Recall of `expected` facts in the Context Packet; `null` when the scenario expects nothing in that category. */
export interface DiscoveryAccuracy {
  languages: number | null;
  frameworks: number | null;
  packageManagers: number | null;
  instructions: number | null;
  /** Micro-averaged recall over every expected fact (1 when nothing is expected). */
  overall: number;
  /** Expected facts discovery did not find, as `category:name`. */
  missed: string[];
}

export interface ScenarioResult {
  id: string;
  fixture: string;
  task: string;
  runId?: string;
  /** Status of the last bridge response, or `error` when the run threw. */
  finalStatus: BridgeResponse["status"] | "error";
  finalState?: string;
  activated: boolean;
  timedOut: boolean;
  /** Active processing consumed by the run (SLA clock; includes simulated host latency). */
  activeMs: number;
  /** Wall-clock time for the whole scenario as seen by the benchmark (excludes fixture copy/cleanup). */
  wallMs: number;
  discoveryMs?: number;
  compilationMs?: number;
  evaluationMs?: number;
  activationMs?: number;
  packetTokens?: number;
  packetFiles?: number;
  /** Host LLM outputs the orchestrator received and validated (metrics.hostSubmissions). */
  hostSubmissions: number;
  /** Host turns simulated by the benchmark (each analyze / compile submission; deterministic compile included). */
  hostTurns: number;
  /** Every bridge command issued (start, analyze, clarify, compile). */
  bridgeCalls: number;
  clarificationRounds: number;
  targetedDiscoveryRounds: number;
  skillName?: string;
  skillTokens?: number;
  accuracy: DiscoveryAccuracy;
  slaViolated: boolean;
  error?: string;
}

export interface Distribution {
  p50: number;
  p95: number;
  max: number;
}

export interface BenchmarkSummary {
  count: number;
  activated: number;
  /** Fraction of scenarios whose run timed out (0..1). */
  timeoutRate: number;
  activeMs: Distribution;
  discoveryMs: Distribution;
  packetTokens: Distribution;
  skillTokens: Distribution;
  meanRecall: number;
  /** Ids of scenarios whose active time exceeded 60 000 ms or that timed out. */
  slaViolations: string[];
}

export interface BenchmarkReport {
  generatedAt: string;
  environment: { node: string; platform: string; hostLatencyMs: number; harness: HarnessId };
  scenarios: ScenarioResult[];
  summary: BenchmarkSummary;
}

// ---------------------------------------------------------------------------
// Defaults and loading
// ---------------------------------------------------------------------------

/** Resolves from `src/benchmark/` and `dist/benchmark/` alike. */
export const DEFAULT_SCENARIOS_PATH = fileURLToPath(new URL("../../benchmarks/scenarios.json", import.meta.url));
export const DEFAULT_FIXTURES_ROOT = fileURLToPath(new URL("../../fixtures", import.meta.url));

export async function loadScenarios(scenariosPath: string = DEFAULT_SCENARIOS_PATH): Promise<BenchmarkScenario[]> {
  const raw = JSON.parse(await readFile(scenariosPath, "utf8")) as unknown;
  const list = Array.isArray(raw) ? raw : (raw as { scenarios?: unknown }).scenarios;
  if (!Array.isArray(list)) throw new Error(`${scenariosPath}: expected an array or { "scenarios": [...] }`);
  const ids = new Set<string>();
  return list.map((s: unknown, i: number) => {
    const sc = s as Partial<BenchmarkScenario>;
    const e = sc.expected as Partial<ExpectedContext> | undefined;
    const isList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
    if (
      typeof sc.id !== "string" ||
      typeof sc.fixture !== "string" ||
      typeof sc.task !== "string" ||
      !e ||
      !isList(e.languages) ||
      !isList(e.frameworks) ||
      !isList(e.packageManagers) ||
      (e.instructions !== undefined && !isList(e.instructions))
    ) {
      throw new Error(`${scenariosPath}: scenario #${i} must be { id, fixture, task, expected: { languages, frameworks, packageManagers, instructions? } }`);
    }
    if (ids.has(sc.id)) throw new Error(`${scenariosPath}: duplicate scenario id "${sc.id}"`);
    ids.add(sc.id);
    return sc as BenchmarkScenario;
  });
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

/**
 * §18.7 performance benchmarks. Each scenario copies its fixture to a temp directory and drives a real
 * generation run (start → analyze → compile --deterministic → active) on the real monotonic clock, with
 * {@link standInAnalysis} standing in for the host LLM. Scenarios run sequentially so timings do not interfere.
 */
export async function runBenchmarks(opts: BenchmarkOptions = {}): Promise<BenchmarkReport> {
  const hostLatencyMs = Math.max(0, opts.hostLatencyMs ?? 0);
  const harness = opts.harness ?? "claude";
  const fixturesRoot = opts.fixturesRoot ?? DEFAULT_FIXTURES_ROOT;
  let scenarios = await loadScenarios(opts.scenariosPath ?? DEFAULT_SCENARIOS_PATH);
  if (opts.scenarioIds) {
    const known = new Set(scenarios.map((s) => s.id));
    const unknown = opts.scenarioIds.filter((id) => !known.has(id));
    if (unknown.length > 0) throw new Error(`Unknown benchmark scenario id(s): ${unknown.join(", ")}`);
    const wanted = new Set(opts.scenarioIds);
    scenarios = scenarios.filter((s) => wanted.has(s.id));
  }

  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    results.push(await runScenario(scenario, { fixturesRoot, hostLatencyMs, harness }));
  }
  return {
    generatedAt: isoNow(),
    environment: { node: process.version, platform: `${process.platform}-${process.arch}`, hostLatencyMs, harness },
    scenarios: results,
    summary: summarize(results),
  };
}

async function runScenario(
  scenario: BenchmarkScenario,
  ctx: { fixturesRoot: string; hostLatencyMs: number; harness: HarnessId },
): Promise<ScenarioResult> {
  const root = await mkdtemp(path.join(tmpdir(), "ds-bench-repo-"));
  const home = await mkdtemp(path.join(tmpdir(), "ds-bench-home-"));
  let packet: ContextPacket | undefined;
  let last: BridgeResponse | undefined;
  let runId: string | undefined;
  let bridgeCalls = 0;
  let hostTurns = 0;
  let clarificationRounds = 0;
  let error: string | undefined;
  let metrics: RunMetrics | undefined;
  let skill: { name?: string; tokenCount?: number } | undefined;
  let finalState: string | undefined;
  let wallMs = 0;

  try {
    await cp(path.join(ctx.fixturesRoot, scenario.fixture), root, { recursive: true });
    // Temp homeDir and an empty PATH: no real harness directories or CLIs are touched.
    const orch = new Orchestrator({ root, harness: ctx.harness, homeDir: home, sessionId: `bench_${scenario.id.replace(/[^A-Za-z0-9_-]/g, "_")}`, env: { PATH: "" } });
    const hostTurn = async (): Promise<void> => {
      hostTurns++;
      if (ctx.hostLatencyMs > 0) await sleep(ctx.hostLatencyMs);
    };
    const wall = stopwatch();
    try {
      last = await orch.start({ task: { description: scenario.task }, forceGenerate: true });
      bridgeCalls++;
      runId = last.runId;
      for (let step = 0; step < MAX_BRIDGE_STEPS; step++) {
        const current: BridgeResponse = last;
        if (current.status === "awaiting_analysis") {
          packet = JSON.parse(await readFile(current.packetPath as string, "utf8")) as ContextPacket;
          const analysis = standInAnalysis(packet);
          await hostTurn();
          last = await orch.analyze(current.runId, analysis);
        } else if (current.status === "awaiting_clarification") {
          // The user declines every question; the SLA is paused during this wait (§6.4), so no latency is simulated.
          const request = current.request as ClarificationRequest;
          clarificationRounds++;
          last = await orch.clarify(current.runId, {
            runId: current.runId,
            round: request.round,
            answers: request.questions.map((q) => ({ questionId: q.id, status: "declined" as const })),
          });
        } else if (current.status === "awaiting_skill_draft" || current.status === "revision_required") {
          await hostTurn();
          last = await orch.compile(current.runId, { deterministic: true });
        } else {
          break;
        }
        bridgeCalls++;
      }
      if (last.status === "invalid_input") error = `invalid input: ${JSON.stringify(last.issues)}`;
    } finally {
      wallMs = wall();
    }
    if (runId) {
      const status = await orch.status(runId);
      metrics = status.metrics as RunMetrics;
      finalState = status.state;
      skill = status.skill as typeof skill;
    }
  } catch (err) {
    error = errorMessage(err);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }

  const activated = last?.status === "active";
  const timedOut = metrics?.timedOut ?? false;
  const activeMs = Math.round(metrics?.activeMs ?? last?.budget.consumedMs ?? wallMs);
  const responseSkill = last?.skill as { tokenCount?: number; name?: string } | undefined;
  return {
    id: scenario.id,
    fixture: scenario.fixture,
    task: scenario.task,
    ...(runId ? { runId } : {}),
    finalStatus: last?.status ?? "error",
    ...(finalState ? { finalState } : {}),
    activated,
    timedOut,
    activeMs,
    wallMs: Math.round(wallMs),
    ...defined("discoveryMs", round(metrics?.discoveryMs)),
    ...defined("compilationMs", round(metrics?.compilationMs)),
    ...defined("evaluationMs", round(metrics?.evaluationMs)),
    ...defined("activationMs", round(metrics?.activationMs)),
    ...defined("packetTokens", metrics?.packetTokens),
    ...defined("packetFiles", metrics?.packetFiles),
    hostSubmissions: metrics?.hostSubmissions ?? 0,
    hostTurns,
    bridgeCalls,
    clarificationRounds,
    targetedDiscoveryRounds: metrics?.targetedDiscoveryRounds ?? 0,
    ...defined("skillName", skill?.name ?? responseSkill?.name),
    ...defined("skillTokens", skill?.tokenCount ?? responseSkill?.tokenCount),
    accuracy: discoveryAccuracy(scenario.expected, packet),
    slaViolated: timedOut || activeMs > SLA_MS,
    ...(error ? { error } : {}),
  };
}

function defined<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

function round(n: number | undefined): number | undefined {
  return n === undefined ? undefined : Math.round(n * 10) / 10;
}

// ---------------------------------------------------------------------------
// Accuracy and summary
// ---------------------------------------------------------------------------

function norm(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Recall of the scenario's expected facts in the Context Packet produced by programmatic discovery. */
export function discoveryAccuracy(expected: ExpectedContext, packet: ContextPacket | undefined): DiscoveryAccuracy {
  const found = {
    languages: packet?.technology.languages ?? [],
    frameworks: packet?.technology.frameworks.map((f) => f.name) ?? [],
    packageManagers: packet?.technology.packageManagers ?? [],
    instructions: packet?.instructions.map((i) => i.path) ?? [],
  };
  const categories = ["languages", "frameworks", "packageManagers", "instructions"] as const;
  const missed: string[] = [];
  let hits = 0;
  let total = 0;
  const recall = {} as Record<(typeof categories)[number], number | null>;
  for (const cat of categories) {
    const want = expected[cat] ?? [];
    if (want.length === 0) {
      recall[cat] = null;
      continue;
    }
    const have = new Set(found[cat].map(cat === "instructions" ? (p: string) => p.replace(/\\/g, "/") : norm));
    let catHits = 0;
    for (const w of want) {
      const key = cat === "instructions" ? w.replace(/\\/g, "/") : norm(w);
      if (have.has(key)) catHits++;
      else missed.push(`${cat}:${w}`);
    }
    hits += catHits;
    total += want.length;
    recall[cat] = catHits / want.length;
  }
  return { ...recall, overall: total === 0 ? 1 : hits / total, missed };
}

/** Nearest-rank percentile of `values` (0 for an empty list). */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1] ?? 0;
}

function distribution(values: Array<number | undefined>): Distribution {
  const xs = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return { p50: percentile(xs, 50), p95: percentile(xs, 95), max: xs.length === 0 ? 0 : Math.max(...xs) };
}

export function summarize(results: ScenarioResult[]): BenchmarkSummary {
  const count = results.length;
  return {
    count,
    activated: results.filter((r) => r.activated).length,
    timeoutRate: count === 0 ? 0 : results.filter((r) => r.timedOut).length / count,
    activeMs: distribution(results.map((r) => r.activeMs)),
    discoveryMs: distribution(results.map((r) => r.discoveryMs)),
    packetTokens: distribution(results.map((r) => r.packetTokens)),
    skillTokens: distribution(results.map((r) => r.skillTokens)),
    meanRecall: count === 0 ? 0 : results.reduce((sum, r) => sum + r.accuracy.overall, 0) / count,
    slaViolations: results.filter((r) => r.slaViolated).map((r) => r.id),
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const dash = "–";
const fmt = (n: number | undefined, digits = 0): string => (n === undefined ? dash : n.toFixed(digits));
const pct = (n: number | null): string => (n === null ? dash : `${Math.round(n * 100)}%`);

/** Markdown: one row per scenario, then a summary block. */
export function formatBenchmarkTable(report: BenchmarkReport): string {
  const header = [
    "Scenario",
    "Status",
    "Active ms",
    "Discovery ms",
    "Compile ms",
    "Eval ms",
    "Activation ms",
    "Packet tokens",
    "Packet files",
    "Host turns",
    "Skill tokens",
    "Recall",
  ];
  const rows = report.scenarios.map((r) => [
    r.id,
    r.timedOut ? `${r.finalStatus} (timeout)` : r.finalStatus,
    fmt(r.activeMs),
    fmt(r.discoveryMs),
    fmt(r.compilationMs),
    fmt(r.evaluationMs),
    fmt(r.activationMs),
    fmt(r.packetTokens),
    fmt(r.packetFiles),
    String(r.hostTurns),
    fmt(r.skillTokens),
    pct(r.accuracy.overall),
  ]);
  const line = (cells: string[]): string => `| ${cells.join(" | ")} |`;
  const s = report.summary;
  const dist = (d: Distribution, unit = ""): string => `p50 ${fmt(d.p50)}${unit} · p95 ${fmt(d.p95)}${unit} · max ${fmt(d.max)}${unit}`;
  const missed = report.scenarios.filter((r) => r.accuracy.missed.length > 0).map((r) => `${r.id}: ${r.accuracy.missed.join(", ")}`);
  const errors = report.scenarios.filter((r) => r.error).map((r) => `${r.id}: ${r.error}`);
  return [
    `### Dynamic Skills benchmark (${report.generatedAt})`,
    "",
    `Node ${report.environment.node} · ${report.environment.platform} · harness ${report.environment.harness} · simulated host latency ${report.environment.hostLatencyMs} ms per host turn`,
    "",
    line(header),
    line(header.map((_, i) => (i <= 1 ? "---" : "---:"))),
    ...rows.map(line),
    "",
    "**Summary**",
    "",
    `- Scenarios: ${s.count} · activated: ${s.activated} · timeout rate: ${pct(s.timeoutRate)}`,
    `- Active time: ${dist(s.activeMs, " ms")} (SLA ${SLA_MS} ms per run, end to end)`,
    `- Discovery: ${dist(s.discoveryMs, " ms")}`,
    `- Packet tokens: ${dist(s.packetTokens)}`,
    `- Skill tokens: ${dist(s.skillTokens)}`,
    `- Mean discovery recall: ${pct(s.meanRecall)}`,
    `- SLA violations: ${s.slaViolations.length === 0 ? "none" : s.slaViolations.join(", ")}`,
    ...(missed.length > 0 ? ["", "Missed expected facts:", ...missed.map((m) => `- ${m}`)] : []),
    ...(errors.length > 0 ? ["", "Errors:", ...errors.map((e) => `- ${e}`)] : []),
    "",
  ].join("\n");
}
