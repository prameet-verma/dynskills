import path from "node:path";
import type { ContextFile, ContextPacket, DiscoveryEvidence, DiscoveryLimits, DiscoveryReport, TaskIntent } from "../contracts/index.js";
import { SCHEMA_VERSION } from "../contracts/index.js";
import { isSourcePath, taskScopePaths } from "../discovery/relevance.js";
import {
  ENTRY_OVERHEAD_TOKENS,
  LimitTracker,
  MIN_USEFUL_TOKENS,
  byteLength,
  enforceTokenBudget,
  finalizeTokens,
  fitContent,
  jsonTokens,
  measurePacket,
  readRedacted,
  resolveLimits,
  sanitizeEvidence,
} from "./budget.js";

export interface BuildContextPacketInput {
  runId: string;
  task: TaskIntent;
  root: string;
  repository: { repositoryId?: string; revision?: string; workingDirectory?: string };
  report: DiscoveryReport;
  limits: DiscoveryLimits;
}

/** Share of the content token budget per category; unused share rolls forward. */
const SHARES = { instructions: 0.3, configuration: 0.2, sources: 0.5 } as const;
/** Share of maxFiles per category; unused share rolls forward. */
const FILE_SHARES = { instructions: 0.3, configuration: 0.25, sources: 0.45 } as const;
/** Share of the source-file budget reserved for files the task names explicitly. */
const PRIORITY_SHARE = 0.7;
/** Evidence is trimmed up-front when it alone would take more than this share of the budget. */
const EVIDENCE_SHARE = 0.5;

const INSTRUCTION_ORDER = ["CLAUDE.md", "AGENTS.md", "GEMINI.md", "copilot-instructions.md", ".cursorrules", ".windsurfrules"];

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const depthOf = (p: string) => p.split("/").length;
const lex = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

// ---------------------------------------------------------------------------
// Consolidation
// ---------------------------------------------------------------------------

export function consolidateTechnology(evidence: DiscoveryEvidence[]): ContextPacket["technology"] {
  const langScore = new Map<string, number>();
  for (const e of evidence.filter((x) => x.kind === "language")) {
    const lang = str(rec(e.value).language);
    if (!lang) continue;
    const files = Number(rec(e.value).files) || 0;
    langScore.set(lang, (langScore.get(lang) ?? 0) + (e.confidence >= 1 ? 1_000_000 : 0) + files);
  }
  const languages = [...langScore].sort((a, b) => b[1] - a[1] || lex(a[0], b[0])).map(([l]) => l);

  const byRuntime = new Map<string, Array<{ version: string; source: string }>>();
  for (const e of evidence.filter((x) => x.kind === "runtime")) {
    const v = rec(e.value);
    const runtime = str(v.runtime);
    const version = str(v.version);
    if (!runtime || !version) continue;
    const list = byRuntime.get(runtime) ?? [];
    list.push({ version, source: e.source });
    byRuntime.set(runtime, list);
  }
  const runtimes: Record<string, string> = {};
  for (const [runtime, list] of [...byRuntime].sort((a, b) => lex(a[0], b[0]))) {
    const distinct = uniq(list.map((l) => l.version));
    runtimes[runtime] = distinct.length === 1 ? (distinct[0] as string) : list.map((l) => `${l.version} (${l.source})`).join(" | ");
  }

  const frameworks: ContextPacket["technology"]["frameworks"] = [];
  const seenFw = new Set<string>();
  for (const e of evidence.filter((x) => x.kind === "framework")) {
    const v = rec(e.value);
    const name = str(v.name);
    if (!name) continue;
    const version = str(v.version);
    const key = `${name}@${version ?? ""}`;
    if (seenFw.has(key)) continue;
    seenFw.add(key);
    frameworks.push({ name, ...(version ? { version } : {}), source: e.source });
  }

  const pm = evidence
    .filter((x) => x.kind === "package_manager")
    .map((e) => ({ name: str(rec(e.value).name), c: e.confidence }))
    .filter((x): x is { name: string; c: number } => !!x.name)
    .sort((a, b) => b.c - a.c || lex(a.name, b.name));
  const packageManagers = uniq(pm.map((p) => p.name));
  const tooling = uniq(
    evidence
      .filter((x) => x.kind === "tooling")
      .map((e) => str(rec(e.value).name))
      .filter((n): n is string => !!n),
  ).sort(lex);
  return { languages, runtimes, frameworks, packageManagers, tooling };
}

function sourceScore(e: DiscoveryEvidence): number {
  return Number(rec(e.value).score) || 0;
}

export function consolidateStructure(evidence: DiscoveryEvidence[], task: TaskIntent): ContextPacket["structure"] {
  const workspaces = uniq(
    evidence
      .filter((e) => e.kind === "workspace")
      .map((e) => str(rec(e.value).path))
      .filter((p): p is string => !!p),
  ).sort(lex);
  const relevantFromSources = evidence
    .filter((e) => e.kind === "source_file")
    .sort((a, b) => sourceScore(b) - sourceScore(a) || lex(a.source, b.source))
    .map((e) => path.posix.dirname(e.source))
    .filter((d) => d !== ".");
  const topDirs = evidence
    .filter((e) => e.kind === "directory")
    .sort((a, b) => (Number(rec(b.value).files) || 0) - (Number(rec(a.value).files) || 0) || lex(a.source, b.source))
    .map((e) => e.source)
    .filter((d) => !d.startsWith("."));
  const relevantDirectories = uniq([...taskScopePaths(task), ...relevantFromSources, ...topDirs]).slice(0, 20);
  const entrypoints = uniq(evidence.filter((e) => e.kind === "entrypoint").map((e) => e.source)).slice(0, 20);
  return { workspaces, relevantDirectories, entrypoints };
}

// ---------------------------------------------------------------------------
// Candidate selection
// ---------------------------------------------------------------------------

function instructionCandidates(evidence: DiscoveryEvidence[]): string[] {
  const rank = (p: string) => {
    const i = INSTRUCTION_ORDER.findIndex((n) => p.endsWith(n));
    return i < 0 ? INSTRUCTION_ORDER.length : i;
  };
  return uniq(evidence.filter((e) => e.kind === "instructions").map((e) => e.source)).sort((a, b) => depthOf(a) - depthOf(b) || rank(a) - rank(b) || lex(a, b));
}

const CONFIG_KIND_WEIGHT: Partial<Record<DiscoveryEvidence["kind"], number>> = {
  configuration: 5,
  dependency: 5,
  workspace: 4,
  test_configuration: 4,
  build_configuration: 3,
  runtime: 2,
  ci_cd: 2,
  tooling: 1,
};

const CONFIG_LIKE_SOURCE = /(^|[.-])(config|conf|rc)\.|^(conftest|noxfile|setup|settings|build|vite|webpack|rollup|jest|vitest|playwright|eslint)\b/i;

interface ConfigCandidate {
  path: string;
  score: number;
  summary: string;
}

function configCandidates(evidence: DiscoveryEvidence[], relevantDirs: string[]): ConfigCandidate[] {
  const byPath = new Map<string, { score: number; claims: string[] }>();
  for (const e of evidence) {
    const w = CONFIG_KIND_WEIGHT[e.kind];
    if (w === undefined || e.source === "." || !/\.[A-Za-z0-9]+$|(^|\/)(Dockerfile|Makefile|Jenkinsfile|\.nvmrc|\.node-version|\.python-version|\.tool-versions|\.cursorrules)$/.test(e.source)) continue;
    // Test/source files referenced as samples are not configuration (task-relevant ones arrive as source files).
    if (isSourcePath(e.source) && !CONFIG_LIKE_SOURCE.test(path.posix.basename(e.source))) continue;
    const entry = byPath.get(e.source) ?? { score: 0, claims: [] };
    entry.score = Math.max(entry.score, w);
    entry.claims.push(e.claim);
    byPath.set(e.source, entry);
  }
  return [...byPath]
    .map(([p, { score, claims }]) => {
      const related = relevantDirs.some((d) => p.startsWith(`${d}/`) || path.posix.dirname(p) === d || d.startsWith(`${path.posix.dirname(p)}/`));
      const s = score + (related ? 3 : 0) - (depthOf(p) - 1) * 1.5;
      const summary = uniq(claims).join("; ");
      return { path: p, score: s, summary: summary.length > 400 ? `${summary.slice(0, 399)}…` : summary };
    })
    .sort((a, b) => b.score - a.score || lex(a.path, b.path));
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/** Trim evidence before content selection when it alone exceeds its share of the budget. */
function pretrimEvidence(packet: ContextPacket, budget: number, tracker: LimitTracker): void {
  const target = Math.floor(budget * EVIDENCE_SHARE);
  if (measurePacket(packet, budget) <= target) return;
  for (const e of packet.evidence) if (e.priority !== "P0") delete e.excerpt;
  if (measurePacket(packet, budget) <= target) return;
  // Drop non-P0 evidence, lowest value first (P2, docs, CI, lowest-ranked source files).
  const rank = (e: DiscoveryEvidence) =>
    (e.priority === "P2" ? 0 : 100) + (e.kind === "documentation" ? 0 : e.kind === "ci_cd" ? 10 : e.kind === "source_file" ? 20 + sourceScore(e) : 50);
  const droppable = packet.evidence.filter((e) => e.priority !== "P0").sort((a, b) => rank(a) - rank(b) || lex(b.id, a.id));
  const drop = new Set<string>();
  for (const e of droppable) {
    drop.add(e.id);
    if (drop.size % 5 === 0) {
      packet.evidence = packet.evidence.filter((x) => !drop.has(x.id));
      if (measurePacket(packet, budget) <= target) break;
    }
  }
  packet.evidence = packet.evidence.filter((x) => !drop.has(x.id));
  if (drop.size) {
    tracker.truncated = true;
    tracker.reason(`${drop.size} non-P0 evidence entries dropped to keep evidence within ${Math.round(EVIDENCE_SHARE * 100)}% of the token budget`);
  }
}

/**
 * §5.3 Context Packet Builder: consolidates discovery evidence into technology/structure, includes
 * instruction files, key configuration and task-relevant source excerpts within the configured file,
 * byte and token limits. All included text is redacted. P0 evidence entries are never dropped.
 */
export async function buildContextPacket(input: BuildContextPacketInput): Promise<ContextPacket> {
  const limits = resolveLimits(input.limits);
  const root = path.resolve(input.root);
  const budget = limits.contextTokenBudget;
  const tracker = new LimitTracker();
  const evidence = input.report.evidence.map(sanitizeEvidence);

  const technology = consolidateTechnology(evidence);
  const structure = consolidateStructure(evidence, input.task);
  const existingSkills = evidence
    .filter((e) => e.kind === "existing_skill")
    .map((e) => {
      const v = rec(e.value);
      return { name: str(v.name) ?? path.posix.basename(path.posix.dirname(e.source)), description: str(v.description) ?? "", path: str(v.path) ?? e.source };
    });

  const instructionPaths = instructionCandidates(evidence);
  const configs = configCandidates(evidence, structure.relevantDirectories);
  const sources = evidence
    .filter((e) => e.kind === "source_file")
    .sort((a, b) => sourceScore(b) - sourceScore(a) || lex(a.source, b.source));

  const packet: ContextPacket = {
    schemaVersion: SCHEMA_VERSION,
    runId: input.runId,
    task: structuredClone(input.task),
    repository: {
      root,
      ...(input.repository.repositoryId ? { repositoryId: input.repository.repositoryId } : {}),
      ...(input.repository.revision ? { revision: input.repository.revision } : {}),
      ...(input.repository.workingDirectory ? { workingDirectory: input.repository.workingDirectory } : {}),
    },
    technology,
    structure,
    instructions: instructionPaths.map((p) => ({ path: p })),
    configuration: configs.map((c) => ({ path: c.path, summary: c.summary })),
    existingSkills,
    sourceFiles: [],
    evidence,
    discoveryLimits: tracker.toJSON(),
    estimatedTokens: 0,
  };

  pretrimEvidence(packet, budget, tracker);

  // Configuration entries are many on large repos; cap the summary-only list too.
  const MAX_CONFIG_ENTRIES = 40;
  if (packet.configuration.length > MAX_CONFIG_ENTRIES) {
    tracker.reason(`${packet.configuration.length - MAX_CONFIG_ENTRIES} lower-priority configuration files listed in evidence only`);
    packet.configuration = packet.configuration.slice(0, MAX_CONFIG_ENTRIES);
  }

  // ---- Content selection --------------------------------------------------
  // Margin for JSON overhead and the limit reasons recorded while selecting content.
  const safety = Math.ceil(budget * 0.02) + 200;
  const available = Math.max(0, budget - measurePacket(packet, budget) - safety);
  let filesAvailable = limits.maxFiles;
  let tokenCarry = 0;
  let fileCarry = 0;
  let maxFilesHit = 0;
  let totalBytesHit = 0;
  let tokenBudgetHit = 0;

  /** Read one candidate within the given token cap; returns undefined when not included. */
  const include = async (rel: string, tokenCap: number): Promise<{ content: string; truncated: boolean } | undefined> => {
    if (tracker.filesRead >= limits.maxFiles) {
      maxFilesHit++;
      tracker.filesSkipped++;
      return undefined;
    }
    const bytesLeft = limits.maxTotalBytes - tracker.bytesUsed;
    if (bytesLeft <= 0) {
      totalBytesHit++;
      tracker.filesSkipped++;
      return undefined;
    }
    if (tokenCap - ENTRY_OVERHEAD_TOKENS < MIN_USEFUL_TOKENS) {
      tokenBudgetHit++;
      tracker.filesSkipped++;
      return undefined;
    }
    const r = await readRedacted(root, rel, Math.min(limits.maxFileBytes, bytesLeft));
    if ("skipped" in r) {
      tracker.filesSkipped++;
      if (r.skipped !== "not_file") tracker.reason(`${rel}: skipped (${r.skipped})`);
      return undefined;
    }
    let truncated = r.truncated;
    if (r.truncated) tracker.reason(`${rel}: truncated to ${Math.min(limits.maxFileBytes, bytesLeft)} bytes`);
    const fitted = fitContent(r.content, tokenCap - ENTRY_OVERHEAD_TOKENS);
    if (fitted.truncated) {
      truncated = true;
      tracker.reason(`${rel}: truncated to fit context token budget`);
    }
    if (fitted.text.trim() === "" && r.content.trim() !== "") {
      tokenBudgetHit++;
      tracker.filesSkipped++;
      return undefined;
    }
    tracker.filesRead++;
    tracker.bytesUsed += byteLength(fitted.text);
    if (truncated) tracker.truncated = true;
    return { content: fitted.text, truncated };
  };

  const runCategory = async <T>(
    items: T[],
    share: number,
    fileShare: number,
    pathOf: (t: T) => string,
    onInclude: (t: T, c: { content: string; truncated: boolean }, cost: number) => void,
    isPriority: (t: T) => boolean = () => false,
  ) => {
    let tokens = Math.floor(available * share) + tokenCarry;
    let files = Math.floor(limits.maxFiles * fileShare) + fileCarry;
    // Files the task names get most of the category, split among themselves; others share the rest.
    let priorityTokens = Math.floor(tokens * PRIORITY_SHARE);
    let priorityLeft = items.filter(isPriority).length;
    for (let i = 0; i < items.length; i++) {
      const item = items[i] as T;
      if (files <= 0 || filesAvailable <= 0) {
        maxFilesHit++;
        tracker.filesSkipped++;
        continue;
      }
      const priority = isPriority(item);
      // Fair share across the next few candidates so one large file cannot starve the rest.
      const remainingCount = Math.min(items.length - i, 4);
      const cap = priority
        ? Math.floor(Math.min(tokens, priorityTokens) / Math.max(1, priorityLeft))
        : Math.floor(tokens / Math.max(1, remainingCount));
      if (priority) priorityLeft--;
      const got = await include(pathOf(item), Math.max(cap, Math.min(tokens, MIN_USEFUL_TOKENS + ENTRY_OVERHEAD_TOKENS)));
      if (!got) continue;
      const cost = jsonTokens(got.content) + ENTRY_OVERHEAD_TOKENS;
      tokens -= cost;
      if (priority) priorityTokens -= cost;
      files--;
      filesAvailable--;
      onInclude(item, got, cost);
    }
    tokenCarry = Math.max(0, tokens);
    fileCarry = Math.max(0, files);
  };

  await runCategory(packet.instructions, SHARES.instructions, FILE_SHARES.instructions, (i) => i.path, (i, c) => {
    i.content = c.content;
  });
  await runCategory(packet.configuration, SHARES.configuration, FILE_SHARES.configuration, (c) => c.path, (c, got) => {
    // The summary only restates evidence claims; the content supersedes it.
    delete c.summary;
    c.content = got.content;
  });
  const sourceFiles: ContextFile[] = [];
  await runCategory(sources, SHARES.sources, FILE_SHARES.sources, (e) => e.source, (e, got) => {
    const matched = Array.isArray(rec(e.value).matched) ? (rec(e.value).matched as unknown[]).map(String) : [];
    sourceFiles.push({
      path: e.source,
      content: got.content,
      truncated: got.truncated,
      reason: `task-relevant${matched.length ? `: matched ${matched.map((m) => `'${m}'`).join(", ")}` : ""}`,
    });
  }, (e) => {
    const matched = rec(e.value).matched;
    return Array.isArray(matched) && matched.some((m) => String(m).startsWith("named in task:"));
  });
  packet.sourceFiles = sourceFiles;

  if (maxFilesHit) tracker.reason(`file limits (maxFiles ${limits.maxFiles}, shared across instructions/configuration/sources) reached: ${maxFilesHit} candidate files not read`);
  if (totalBytesHit) tracker.reason(`maxTotalBytes limit (${limits.maxTotalBytes}) reached: ${totalBytesHit} candidate files not read`);
  if (tokenBudgetHit) tracker.reason(`context token budget (${budget}) exhausted: ${tokenBudgetHit} candidate files not read`);
  if (maxFilesHit || totalBytesHit || tokenBudgetHit) tracker.truncated = true;

  enforceTokenBudget(packet, budget, tracker, new Set(), new Map(configs.map((c) => [c.path, c.summary])));
  packet.discoveryLimits = tracker.toJSON();
  finalizeTokens(packet);
  if (packet.estimatedTokens > budget) {
    // Only possible when P0 evidence alone exceeds the budget (already recorded in reasons).
    packet.discoveryLimits.truncated = true;
  }
  return packet;
}
