import type { AnalysisEvidence, ContextAnalysisResult, ContextPacket } from "../contracts/index.js";

/**
 * Deterministic stand-in for the host LLM's context-analysis step (§5.4), used by the §18.7 benchmarks.
 *
 * In a real run the root agent's own model reads the Context Packet and writes a ContextAnalysisResult.
 * The benchmark replaces that model call with this pure function so runs are reproducible and need no
 * model access. Consequences for interpreting benchmark numbers:
 *
 * - **LLM time is excluded.** This function runs in microseconds, so measured active time covers only the
 *   core's work (discovery, validation, gap analysis, compilation, evaluation, activation) unless the
 *   benchmark simulates host latency (`hostLatencyMs`), which then counts against the 120 s budget.
 * - **Analysis quality is a floor, not a model.** It restates packet facts; it never invents unknowns,
 *   context requests or task-specific insight. It does report runtime-version conflicts the packet already
 *   shows, so the clarification path can still be exercised.
 *
 * Everything is derived from the packet: technology, structure, and repository instruction lines (as
 * conventions). Every `observed` claim cites a packet evidence id or a path present in the packet, so the
 * result passes `validateContextAnalysisResult` for any packet core produces.
 */
export function standInAnalysis(packet: ContextPacket): ContextAnalysisResult {
  const tech = packet.technology;
  const evidence: AnalysisEvidence[] = [];
  const seenClaims = new Set<string>();
  const addEvidence = (e: AnalysisEvidence): void => {
    const key = `${e.claim}|${e.source}`;
    if (seenClaims.has(key) || evidence.length >= MAX_EVIDENCE) return;
    seenClaims.add(key);
    evidence.push(e);
  };

  // Observed technology facts, citing the discovery evidence that established them.
  for (const ev of packet.evidence) {
    if (OBSERVED_KINDS.has(ev.kind)) addEvidence({ claim: ev.claim, source: ev.id, type: "observed", confidence: ev.confidence });
  }

  // Repository instructions → conventions (and imperative lines → constraints), cited by file path.
  const conventions: string[] = [];
  const constraints: string[] = [];
  for (const file of packet.instructions) {
    for (const line of instructionLines(file.content ?? "")) {
      if (conventions.length >= MAX_CONVENTIONS) break;
      if (conventions.includes(line)) continue;
      conventions.push(line);
      if (IMPERATIVE.test(line)) constraints.push(line);
      addEvidence({ claim: line, source: file.path, type: "observed" });
    }
  }

  // Structure: workspaces and entry points.
  const { workspaces, relevantDirectories, entrypoints } = packet.structure;
  const patterns: string[] = [];
  if (workspaces.length > 1) {
    patterns.push(`Multi-package workspace: ${workspaces.join(", ")}`);
    const ws = workspaces[0];
    if (ws) addEvidence({ claim: `The repository is split into ${workspaces.length} workspace packages`, source: ws, type: "inferred" });
  }
  if (tech.languages.length > 1) patterns.push(`Polyglot repository: ${tech.languages.join(", ")}`);
  for (const entry of entrypoints) {
    addEvidence({ claim: `${entry} is an application entry point`, source: entry, type: "inferred" });
  }
  const moduleStructure = unique([...workspaces, ...relevantDirectories]);

  // Task focus: structure entries mentioned by (or sharing a word with) the task, else the entry points.
  const taskTokens = new Set(tokens(`${packet.task.description} ${(packet.task.scope ?? []).join(" ")}`));
  const candidates = unique([...workspaces, ...relevantDirectories, ...entrypoints, ...packet.sourceFiles.map((f) => f.path)]);
  const focused = candidates.filter((p) => tokens(p).some((t) => taskTokens.has(t)));
  const relevantComponents = focused.length > 0 ? focused : entrypoints.slice(0, 3);
  const existingImplementations = unique(packet.sourceFiles.map((f) => f.path)).slice(0, 5);

  // Runtime pins that disagree across sources ("18 (.nvmrc) | 22 (Dockerfile)") are conflicts (§5.4).
  // Compatible statements ("20.11.1 (.nvmrc) | >=20 (package.json)") are not.
  const conflicts: ContextAnalysisResult["conflicts"] = [];
  for (const [runtime, value] of Object.entries(tech.runtimes)) {
    const observations = value.split(" | ").map((s) => s.trim()).filter(Boolean);
    if (observations.length < 2 || !pinsDisagree(observations)) continue;
    const runtimeEvidence = packet.evidence.filter((e) => e.kind === "runtime" && e.claim.toLowerCase().includes(runtime.toLowerCase()));
    const sources = runtimeEvidence.length > 0 ? runtimeEvidence.map((e) => e.id) : packet.configuration.map((c) => c.path).slice(0, 3);
    if (sources.length === 0) continue;
    conflicts.push({ subject: `${runtime} runtime version`, observations, sources });
  }

  return {
    schemaVersion: "1.0",
    runId: packet.runId,
    technology: {
      languages: [...tech.languages],
      frameworks: tech.frameworks.map((f) => (f.version ? `${f.name} ${f.version}` : f.name)),
      runtimes: Object.entries(tech.runtimes).map(([name, version]) => `${name} ${version}`),
      packageManagers: [...tech.packageManagers],
    },
    architecture: {
      patterns,
      moduleStructure,
      conventions,
      dependencies: unique([...tech.frameworks.map((f) => f.name), ...tech.tooling]),
    },
    taskContext: {
      relevantComponents,
      existingImplementations,
      constraints,
    },
    evidence,
    unknowns: [],
    conflicts,
  };
}

const MAX_EVIDENCE = 60;
const MAX_CONVENTIONS = 20;
const OBSERVED_KINDS = new Set<string>(["language", "runtime", "framework", "package_manager", "workspace", "test_configuration"]);
const IMPERATIVE = /\b(must|never|always|only|do not|don't|before)\b/i;

/** Bullet or sentence lines of an instruction file, without Markdown headings, list markers or code fences. */
function instructionLines(content: string): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence || line === "" || line.startsWith("#")) continue;
    const text = line.replace(/^(?:[-*+]|\d+[.)])\s+/, "").trim();
    if (text.length >= 8) out.push(text);
  }
  return out;
}

/**
 * True when at least two observations pin exact versions that cannot both hold ("18" vs "22").
 * Ranges (">=20", "^3.11") are ignored; "20" and "20.11.1" agree because one refines the other.
 */
function pinsDisagree(observations: string[]): boolean {
  const pins = observations
    .map((o) => (o.split(" (")[0] ?? "").trim().replace(/^v/i, ""))
    .filter((v) => /^\d+(?:\.\d+)*$/.test(v))
    .map((v) => v.split("."));
  return pins.some((a, i) => pins.slice(i + 1).some((b) => a.slice(0, Math.min(a.length, b.length)).join(".") !== b.slice(0, Math.min(a.length, b.length)).join(".")));
}

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t));
}

const STOP_WORDS = new Set(["src", "the", "and", "for", "with", "add", "that", "from", "main", "app", "test", "tests", "lib"]);

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
