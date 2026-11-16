#!/usr/bin/env node
import { Command, Option } from "commander";
import path from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { access, constants, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_CONFIG,
  HARNESS_IDS,
  type ContextAnalysisResult,
  type GeneratedSkill,
  type HarnessId,
  type PersistenceChoice,
  type TaskIntent,
} from "../contracts/index.js";
import { DynamicSkillsError, GENERATOR_VERSION, dsError, errorMessage, estimateTokens, hashSkillFiles, PRODUCT_NAME } from "../core/index.js";
import { Orchestrator } from "../orchestrator/orchestrator.js";
import { loadConfig } from "../orchestrator/config.js";
import { RunStore } from "../orchestrator/run-store.js";
import { RepositoryScanner, getRepositoryIdentity } from "../discovery/index.js";
import { buildContextPacket } from "../context-packet/index.js";
import { ArtifactStore, ensureRuntimeRoot, runtimeRoot } from "../storage/index.js";
import { createAdapter } from "../adapters/index.js";
import { detectHarnesses, installBootstrap } from "../adapter-sdk/index.js";
import { schemaPath } from "../context-analyzer-contracts/index.js";
import { parseSkillMarkdown } from "../skill-compiler/index.js";
import { checkConciseness, checkPortability, checkSecurity, checkStructural, type EvalContext } from "../eval-engine/index.js";

/** Package root (works from src/cli and dist/cli). */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const BOOTSTRAP_SOURCE_DIR = path.join(PACKAGE_ROOT, "skills", "dynamic-skill-bootstrap");

function findProjectRoot(start: string): string {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start);
    dir = parent;
  }
}

interface GlobalOpts {
  root?: string;
  home?: string;
  json?: boolean;
}

function globals(cmd: Command): GlobalOpts {
  return cmd.optsWithGlobals() as GlobalOpts;
}

function rootOf(g: GlobalOpts): string {
  return g.root ? path.resolve(g.root) : findProjectRoot(process.cwd());
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function parseHarness(value: string): HarnessId {
  const v = value === "claude-code" ? "claude" : value;
  if (!(HARNESS_IDS as readonly string[]).includes(v)) {
    throw dsError("configuration", "cli", `Unknown harness "${value}" (expected ${HARNESS_IDS.join(", ")})`, { recoverable: true });
  }
  return v as HarnessId;
}

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function fail(err: unknown, asJson: boolean): never {
  const info = err instanceof DynamicSkillsError ? err.info : { category: "internal", component: "cli", message: errorMessage(err), recoverable: false };
  if (asJson) print({ status: "error", error: info });
  else process.stderr.write(`${PRODUCT_NAME}: ${info.message}\n`);
  process.exit(err instanceof DynamicSkillsError && err.info.category === "invalid_state" ? 2 : 1);
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name(PRODUCT_NAME)
    .description("Just-in-Time Skill Synthesizer for AI coding agents")
    .version(GENERATOR_VERSION)
    .option("--root <dir>", "repository root (default: nearest git root or cwd)")
    .addOption(new Option("--home <dir>", "home directory override (testing)").hideHelp())
    .option("--json", "machine-readable output");

  // ---------------------------------------------------------------- init
  program
    .command("init")
    .description("Install the bootstrap skill into supported harnesses")
    .option("--harness <list>", "comma-separated harnesses (claude,codex,opencode); default: detected")
    .option("--global", "install into personal (user-level) skill directories")
    .option("--force", "replace a conflicting bootstrap skill")
    .action(async (opts: { harness?: string; global?: boolean; force?: boolean }, cmd: Command) => {
      const g = globals(cmd);
      const root = rootOf(g);
      try {
        let harnesses: HarnessId[];
        if (opts.harness) harnesses = opts.harness.split(",").map((h) => parseHarness(h.trim()));
        else {
          const detected = await detectHarnesses({ projectRoot: root, ...(g.home ? { homeDir: g.home } : {}) });
          harnesses = detected.map((d) => d.id);
          if (harnesses.length === 0) {
            throw dsError("configuration", "cli", "No supported harness detected. Pass --harness claude,codex,opencode", { recoverable: true });
          }
        }
        await ensureRuntimeRoot(root);
        const scope = opts.global ? "personal" : "project";
        const results = [];
        for (const id of harnesses) {
          const adapter = createAdapter(id, { projectRoot: root, ...(g.home ? { homeDir: g.home } : {}) });
          await adapter.initialize();
          const res = await installBootstrap({ adapter, scope, sourceDir: BOOTSTRAP_SOURCE_DIR, ...(opts.force ? { force: true } : {}) });
          const discoverable = (await adapter.getExistingSkills()).some((s) => s.name === "dynamic-skill-bootstrap");
          results.push({ harness: id, scope, ...res, discoverable });
        }
        if (g.json) print({ status: "ok", results });
        else {
          for (const r of results) {
            const mark = r.status === "conflict" ? "✗" : r.discoverable ? "✓" : "!";
            process.stdout.write(`${mark} ${r.harness}: bootstrap ${r.status} at ${r.path}${r.discoverable ? "" : " (not yet discoverable)"}\n`);
          }
          if (results.some((r) => r.status === "conflict")) process.stdout.write("Re-run with --force to replace conflicting copies.\n");
        }
        if (results.some((r) => r.status === "conflict")) process.exitCode = 1;
      } catch (err) {
        fail(err, !!g.json);
      }
    });

  // ---------------------------------------------------------------- doctor
  program
    .command("doctor")
    .description("Diagnose installation and compatibility")
    .action(async (_opts: unknown, cmd: Command) => {
      const g = globals(cmd);
      const root = rootOf(g);
      const checks: Array<{ check: string; status: "ok" | "warn" | "fail"; detail: string }> = [];
      const major = Number(process.versions.node.split(".")[0]);
      checks.push({ check: "node", status: major >= 26 ? "ok" : "fail", detail: `Node ${process.versions.node} (requires ≥ 26)` });
      try {
        await loadConfig(root);
        checks.push({ check: "config", status: "ok", detail: existsSync(path.join(root, "dynamic-skills.config.json")) ? "dynamic-skills.config.json valid" : "defaults (no config file)" });
      } catch (err) {
        checks.push({ check: "config", status: "fail", detail: errorMessage(err) });
      }
      for (const name of ["context-analysis-result", "skill-draft", "clarification-response"] as const) {
        const p = schemaPath(name);
        checks.push({ check: `schema:${name}`, status: existsSync(p) ? "ok" : "fail", detail: p });
      }
      checks.push({ check: "bootstrap-source", status: existsSync(path.join(BOOTSTRAP_SOURCE_DIR, "SKILL.md")) ? "ok" : "fail", detail: BOOTSTRAP_SOURCE_DIR });
      try {
        const rt = await ensureRuntimeRoot(root);
        await access(rt, constants.W_OK);
        const ignored = existsSync(path.join(rt, ".gitignore"));
        checks.push({ check: "runtime-dir", status: ignored ? "ok" : "warn", detail: `${rt}${ignored ? " (git-ignored)" : " (not git-ignored)"}` });
      } catch (err) {
        checks.push({ check: "runtime-dir", status: "fail", detail: errorMessage(err) });
      }
      const detected = await detectHarnesses({ projectRoot: root, ...(g.home ? { homeDir: g.home } : {}) });
      if (detected.length === 0) checks.push({ check: "harness", status: "warn", detail: "no supported harness detected" });
      for (const d of detected) {
        const adapter = createAdapter(d.id, { projectRoot: root, ...(g.home ? { homeDir: g.home } : {}) });
        const caps = await adapter.getCapabilities();
        const skills = await adapter.getExistingSkills().catch(() => []);
        const boot = skills.some((s) => s.name === "dynamic-skill-bootstrap");
        checks.push({ check: `harness:${d.id}`, status: "ok", detail: `${d.reasons.join("; ")}; activation: ${caps.activation.join(" > ")}` });
        checks.push({
          check: `bootstrap:${d.id}`,
          status: boot ? "ok" : "warn",
          detail: boot ? "bootstrap skill discoverable" : `bootstrap not installed — run \`${PRODUCT_NAME} init --harness ${d.id}\``,
        });
      }
      if (g.json) print({ status: checks.some((c) => c.status === "fail") ? "fail" : "ok", checks });
      else for (const c of checks) process.stdout.write(`${c.status === "ok" ? "✓" : c.status === "warn" ? "!" : "✗"} ${c.check}: ${c.detail}\n`);
      if (checks.some((c) => c.status === "fail")) process.exitCode = 1;
    });

  // ---------------------------------------------------------------- validate
  program
    .command("validate <dir>")
    .description("Validate an Agent Skills artifact (structure, conciseness, portability, security)")
    .action(async (dir: string, _opts: unknown, cmd: Command) => {
      const g = globals(cmd);
      try {
        const abs = path.resolve(dir);
        const store = new ArtifactStore({ projectRoot: abs });
        const files = await store.readSkillDir(abs);
        const skillMd = files.find((f) => f.path === "SKILL.md");
        const parsed = skillMd ? parseSkillMarkdown(skillMd.content) : undefined;
        const fm = parsed?.frontmatter ?? {};
        const name = typeof fm.name === "string" ? fm.name : path.basename(abs);
        const artifactHash = hashSkillFiles(files);
        const skill: GeneratedSkill = {
          skillId: `${name}@${artifactHash.slice(0, 12)}`,
          name,
          description: typeof fm.description === "string" ? fm.description : "",
          files,
          artifactHash,
          tokenCount: estimateTokens(skillMd?.content ?? ""),
          provenance: {
            runId: "validate",
            repositoryId: "validate",
            generatorVersion: GENERATOR_VERSION,
            skillVersion: "0.0.0",
            contextFingerprint: "",
            evidenceIds: [],
            assumptionIds: [],
            createdAt: new Date().toISOString(),
          },
        };
        const ctx: EvalContext = {
          task: { description: skill.description },
          analysis: emptyAnalysis(),
          knownEvidenceIds: new Set(),
          knownPaths: new Set(),
          assumptionIds: new Set(),
          existingSkills: [],
          repositoryInstructions: [],
          policy: {
            targetTokenCount: DEFAULT_CONFIG.generation.targetSkillTokens,
            maximumTokenCount: DEFAULT_CONFIG.generation.maximumSkillTokens,
            requireEvidence: false,
            portability: "agent-skills",
          },
          expectedDirName: path.basename(abs),
        };
        const results = [checkStructural(skill, ctx), checkConciseness(skill, ctx), checkPortability(skill, ctx), checkSecurity(skill, ctx)];
        const failed = results.some((r) => r.mandatory && r.status === "fail");
        const status = failed ? "fail" : results.some((r) => r.status !== "pass") ? "warning" : "pass";
        if (g.json) print({ status, skill: { name, tokenCount: skill.tokenCount, artifactHash }, checks: results });
        else {
          process.stdout.write(`${name} — ${status.toUpperCase()} (${skill.tokenCount} tokens)\n`);
          for (const r of results) {
            process.stdout.write(`  ${r.status === "pass" ? "✓" : r.status === "warning" ? "!" : "✗"} ${r.checkId}\n`);
            for (const f of r.findings) process.stdout.write(`      ${f.severity}: ${f.message}${f.path ? ` (${f.path})` : ""}\n`);
          }
        }
        if (failed) process.exitCode = 1;
      } catch (err) {
        fail(err, !!g.json);
      }
    });

  // ---------------------------------------------------------------- inspect
  program
    .command("inspect")
    .description("Inspect the current repository discovery profile")
    .option("--task <text>", "task description used for relevance ranking", "Inspect repository")
    .option("--full", "print the whole Context Packet (JSON)")
    .action(async (opts: { task: string; full?: boolean }, cmd: Command) => {
      const g = globals(cmd);
      const root = rootOf(g);
      try {
        const config = await loadConfig(root);
        const limits = {
          maxFiles: config.discovery.maximumFiles,
          maxFileBytes: config.discovery.maximumFileBytes,
          maxTotalBytes: config.discovery.maximumTotalBytes,
          contextTokenBudget: config.discovery.contextTokenBudget,
          providerTimeoutMs: config.discovery.providerTimeoutMs,
          concurrency: config.discovery.concurrency,
        };
        const task: TaskIntent = { description: opts.task };
        const report = await new RepositoryScanner().scan({ root, task, limits, maxPriority: "P1" });
        const repo = await getRepositoryIdentity(root);
        const packet = await buildContextPacket({
          runId: "inspect",
          task,
          root,
          repository: { repositoryId: repo.repositoryId, ...(repo.revision ? { revision: repo.revision } : {}) },
          report,
          limits,
        });
        if (opts.full || g.json) {
          print(opts.full ? packet : { repository: repo, technology: packet.technology, structure: packet.structure, providers: report.providers, evidence: packet.evidence.length, limits: packet.discoveryLimits, estimatedTokens: packet.estimatedTokens });
          return;
        }
        const t = packet.technology;
        const out = [
          `Repository: ${root} (${repo.repositoryId}${repo.revision ? ` @ ${repo.revision.slice(0, 8)}` : ""})`,
          `Languages: ${t.languages.join(", ") || "—"}`,
          `Runtimes: ${Object.entries(t.runtimes).map(([k, v]) => `${k} ${v}`).join(", ") || "—"}`,
          `Frameworks: ${t.frameworks.map((f) => (f.version ? `${f.name}@${f.version}` : f.name)).join(", ") || "—"}`,
          `Package managers: ${t.packageManagers.join(", ") || "—"}`,
          `Tooling: ${t.tooling.join(", ") || "—"}`,
          `Workspaces: ${packet.structure.workspaces.join(", ") || "—"}`,
          `Instructions: ${packet.instructions.map((i) => i.path).join(", ") || "—"}`,
          `Existing skills: ${packet.existingSkills.map((s) => s.name).join(", ") || "—"}`,
          `Evidence: ${packet.evidence.length} facts from ${report.providers.filter((p) => p.status === "ok").length}/${report.providers.length} providers in ${Math.round(report.durationMs)} ms`,
          `Packet: ~${packet.estimatedTokens} tokens, ${packet.discoveryLimits.filesRead} files read${packet.discoveryLimits.truncated ? " (truncated)" : ""}`,
        ];
        const problems = report.providers.filter((p) => p.status !== "ok" && p.status !== "skipped");
        for (const p of problems) out.push(`  ! provider ${p.providerId}: ${p.status}${p.error ? ` — ${p.error}` : ""}`);
        process.stdout.write(`${out.join("\n")}\n`);
      } catch (err) {
        fail(err, !!g.json);
      }
    });

  // ---------------------------------------------------------------- list
  program
    .command("list")
    .description("List generated and persisted skills")
    .action(async (_opts: unknown, cmd: Command) => {
      const g = globals(cmd);
      const root = rootOf(g);
      try {
        const store = new ArtifactStore({ projectRoot: root, ...(g.home ? { homeDir: g.home } : {}) });
        const [project, personal, runs] = await Promise.all([
          store.listBundles("project").catch(() => []),
          store.listBundles("personal").catch(() => []),
          new RunStore(root).list(),
        ]);
        const generated = runs
          .filter((r) => r.skill)
          .map((r) => ({ name: r.skill?.name, runId: r.identity.runId, state: r.state, lifetime: r.persistence?.choice ?? "ephemeral", createdAt: r.createdAt }));
        const bundles = [...project.map((b) => ({ ...b, scope: "project" })), ...personal.map((b) => ({ ...b, scope: "personal" }))].map((b) => ({
          name: b.name,
          scope: b.scope,
          status: b.lifecycleStatus,
          version: b.skillVersion,
          evaluation: b.evaluation.status,
          updatedAt: b.updatedAt,
        }));
        if (g.json) print({ persisted: bundles, runs: generated });
        else {
          process.stdout.write("Persisted skills:\n");
          if (bundles.length === 0) process.stdout.write("  (none)\n");
          for (const b of bundles) process.stdout.write(`  ${b.name}  [${b.scope}, ${b.status}, v${b.version}, eval ${b.evaluation}]\n`);
          process.stdout.write("Generated in runs:\n");
          if (generated.length === 0) process.stdout.write("  (none)\n");
          for (const r of generated) process.stdout.write(`  ${r.name}  [${r.lifetime}, ${r.state}] ${r.runId}\n`);
        }
      } catch (err) {
        fail(err, !!g.json);
      }
    });

  // ---------------------------------------------------------------- clean
  program
    .command("clean")
    .description("Remove expired ephemeral artifacts")
    .option("--all", "remove all ephemeral runs regardless of age")
    .action(async (opts: { all?: boolean }, cmd: Command) => {
      const g = globals(cmd);
      const root = rootOf(g);
      try {
        const config = await loadConfig(root);
        const retentionHours = opts.all ? 0 : config.lifecycle.ephemeralRetentionHours;
        const cutoff = Date.now() - retentionHours * 3_600_000;
        const runStore = new RunStore(root);
        const removedInstalls: string[] = [];
        for (const r of await runStore.list()) {
          const ephemeral = !r.persistence || r.persistence.choice === "ephemeral";
          if (ephemeral && r.skill && Date.parse(r.updatedAt) <= cutoff) {
            const adapter = createAdapter(r.harness, { projectRoot: root, ...(g.home ? { homeDir: g.home } : {}) });
            await adapter.removeSkill(r.skill.skillId, "ephemeral").catch(() => undefined);
            removedInstalls.push(`${r.harness}:${r.skill.name}`);
          }
        }
        const store = new ArtifactStore({ projectRoot: root, ...(g.home ? { homeDir: g.home } : {}) });
        const { removedRuns } = existsSync(runtimeRoot(root)) ? await store.cleanExpired({ retentionHours }) : { removedRuns: [] as string[] };
        if (g.json) print({ status: "ok", removedRuns, removedInstalls });
        else process.stdout.write(`Removed ${removedRuns.length} run(s) and ${removedInstalls.length} ephemeral install(s).\n`);
      } catch (err) {
        fail(err, !!g.json);
      }
    });

  // ---------------------------------------------------------------- run (agent bridge)
  const run = program.command("run").description("Agent bridge: drive a generation run step by step (JSON in/out)");

  const orchestratorFor = (cmd: Command, harness?: string): Orchestrator => {
    const g = globals(cmd);
    return new Orchestrator({
      root: rootOf(g),
      harness: harness ? parseHarness(harness) : "claude",
      ...(g.home ? { homeDir: g.home } : {}),
    });
  };
  const withRun = async (cmd: Command, runId: string, fn: (o: Orchestrator) => Promise<unknown>) => {
    try {
      const g = globals(cmd);
      const record = await new RunStore(rootOf(g)).load(runId);
      print(await fn(orchestratorFor(cmd, record.harness)));
    } catch (err) {
      fail(err, true);
    }
  };

  run
    .command("start")
    .description("Start a run: preflight, discovery and Context Packet")
    .requiredOption("--task <text>", "the task needing expertise")
    .option("--harness <id>", "claude | codex | opencode", "claude")
    .option("--scope <path>", "relevant path (repeatable)", collect)
    .option("--constraint <text>", "known constraint (repeatable)", collect)
    .option("--expected-outcome <text>", "expected outcome")
    .option("--force-generate", "skip reuse of existing skills")
    .action(async (opts: { task: string; harness: string; scope?: string[]; constraint?: string[]; expectedOutcome?: string; forceGenerate?: boolean }, cmd: Command) => {
      try {
        const task: TaskIntent = {
          description: opts.task,
          ...(opts.scope ? { scope: opts.scope } : {}),
          ...(opts.constraint ? { constraints: opts.constraint } : {}),
          ...(opts.expectedOutcome ? { expectedOutcome: opts.expectedOutcome } : {}),
        };
        print(await orchestratorFor(cmd, opts.harness).start({ task, ...(opts.forceGenerate ? { forceGenerate: true } : {}) }));
      } catch (err) {
        fail(err, true);
      }
    });

  run
    .command("analyze <runId>")
    .description("Submit a ContextAnalysisResult JSON")
    .requiredOption("--input <file>", "JSON file, or - for stdin")
    .action(async (runId: string, opts: { input: string }, cmd: Command) => {
      await withRun(cmd, runId, async (o) => o.analyze(runId, await Orchestrator.readInput(opts.input)));
    });

  run
    .command("clarify <runId>")
    .description("Submit the user's ClarificationResponse JSON")
    .requiredOption("--input <file>", "JSON file, or - for stdin")
    .action(async (runId: string, opts: { input: string }, cmd: Command) => {
      await withRun(cmd, runId, async (o) => o.clarify(runId, await Orchestrator.readInput(opts.input)));
    });

  run
    .command("compile <runId>")
    .description("Submit a SkillDraft JSON (or --deterministic); evaluates and activates on success")
    .option("--input <file>", "SkillDraft JSON file, or - for stdin")
    .option("--deterministic", "compile without an LLM draft")
    .option("--behavioural-result <file>", "BehaviouralEvalResult from a host simulation")
    .action(async (runId: string, opts: { input?: string; deterministic?: boolean; behaviouralResult?: string }, cmd: Command) => {
      await withRun(cmd, runId, async (o) => {
        if (!opts.input && !opts.deterministic) throw dsError("configuration", "cli", "Pass --input <file> or --deterministic", { recoverable: true });
        const hostBehaviouralResult = opts.behaviouralResult ? JSON.parse(await readFile(opts.behaviouralResult, "utf8")) : undefined;
        return o.compile(runId, {
          ...(opts.input ? { draft: await Orchestrator.readInput(opts.input) } : {}),
          ...(opts.deterministic ? { deterministic: true } : {}),
          ...(hostBehaviouralResult ? { hostBehaviouralResult } : {}),
        });
      });
    });

  run
    .command("persist <runId>")
    .description("Apply the user's persistence choice (requires explicit approval)")
    .requiredOption("--choice <choice>", "project | personal | ephemeral | discard")
    .action(async (runId: string, opts: { choice: string }, cmd: Command) => {
      await withRun(cmd, runId, async (o) => {
        const choices: PersistenceChoice[] = ["project", "personal", "ephemeral", "discard"];
        if (!(choices as string[]).includes(opts.choice)) {
          throw dsError("configuration", "cli", `--choice must be one of ${choices.join(", ")}`, { recoverable: true });
        }
        return o.persist(runId, opts.choice as PersistenceChoice);
      });
    });

  run
    .command("status <runId>")
    .description("Show run state, budget and metrics")
    .action(async (runId: string, _opts: unknown, cmd: Command) => {
      await withRun(cmd, runId, (o) => o.status(runId));
    });

  run
    .command("cancel <runId>")
    .description("Cancel a run and return control to the root agent")
    .action(async (runId: string, _opts: unknown, cmd: Command) => {
      await withRun(cmd, runId, (o) => o.cancel(runId));
    });

  return program;
}

function emptyAnalysis(): ContextAnalysisResult {
  return {
    schemaVersion: "1.0",
    runId: "validate",
    technology: { languages: [], frameworks: [], runtimes: [], packageManagers: [] },
    architecture: { patterns: [], moduleStructure: [], conventions: [], dependencies: [] },
    taskContext: { relevantComponents: [], existingImplementations: [], constraints: [] },
    evidence: [],
    unknowns: [],
    conflicts: [],
  };
}

const invokedDirectly = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  await buildProgram().parseAsync(process.argv);
}
