import path from "node:path";
import { readFile, rm } from "node:fs/promises";
import {
  STAGE_BUDGET_MS,
  type ActivationResult,
  type Assumption,
  type BehaviouralEvalCase,
  DETERMINISTIC_COMPILE_THRESHOLD_MS,
  type BehaviouralEvalResult,
  type CanonicalBundleRecord,
  type ContextAnalysisResult,
  type ContextPacket,
  type ContextRequest,
  type DynamicSkillsConfig,
  type ErrorInfo,
  type GeneratedSkill,
  type HarnessId,
  type PersistenceChoice,
  type SkillCompilationRequest,
  type SkillDraft,
  type SkillInventoryItem,
  type TaskIntent,
} from "../contracts/index.js";
import {
  DynamicSkillsError,
  GENERATOR_VERSION,
  dsError,
  errorMessage,
  hashSkillFiles,
  isoNow,
  newId,
  readJson,
  readJsonIfExists,
  stopwatch,
  withTimeout,
  writeFileAtomic,
  writeJson,
  TimeoutError,
} from "../core/index.js";
import { RepositoryScanner, discoverExistingSkills, getRepositoryIdentity } from "../discovery/index.js";
import { EvidenceRegistry } from "../evidence-registry/index.js";
import { applyContextRequests, buildContextPacket } from "../context-packet/index.js";
import {
  schemaPath,
  validateClarificationResponse,
  validateContextAnalysisResult,
  validateSkillDraft,
} from "../context-analyzer-contracts/index.js";
import { analyzeContextGaps, assessSkillSufficiency } from "../context-gap-analyzer/index.js";
import { ClarificationManager } from "../clarification-manager/index.js";
import { ExecutionBudget } from "../sla/index.js";
import {
  applyDeterministicFixes,
  buildCompilationPrompt,
  buildCompilationRequest,
  compileDeterministicDraft,
  renderSkill,
} from "../skill-compiler/index.js";
import { compareWithBaseline, createBehaviouralEvalCase, evaluateSkill, planRevision, type EvalContext } from "../eval-engine/index.js";
import { ArtifactStore } from "../storage/index.js";
import { assessFreshness, computeContextFingerprint, findReusableBundles, nextSkillVersion } from "../lifecycle/index.js";
import { createAdapter } from "../adapters/index.js";
import type { AdapterOptions, BaseHarnessAdapter } from "../adapter-sdk/index.js";
import { loadConfig } from "./config.js";
import { RunStore, transition, requestHash, type RunRecord } from "./run-store.js";
import { TERMINAL_STATES, expectedCommand } from "./state-machine.js";

/** Bounded correction attempts for an invalid Context Analysis Result (§17). */
const MAX_ANALYSIS_ATTEMPTS = 3;
/** Bounded targeted discovery rounds (§5.5: targeted and bounded, no repeated full scans). */
const MAX_TARGETED_DISCOVERY_ROUNDS = 2;

export type BridgeStatus =
  | "reuse_existing"
  | "awaiting_analysis"
  | "awaiting_clarification"
  | "awaiting_skill_draft"
  | "revision_required"
  | "active"
  | "completed"
  | "degraded"
  | "failed"
  | "invalid_input"
  | "status";

/** JSON printed to the root agent after every bridge command. `next` tells it exactly what to do. */
export interface BridgeResponse {
  status: BridgeStatus;
  runId: string;
  state: RunRecord["state"];
  next: string;
  budget: { consumedMs: number; remainingMs: number; paused: boolean; clarificationRoundsUsed: number };
  [key: string]: unknown;
}

export interface OrchestratorOptions {
  root: string;
  harness: HarnessId;
  homeDir?: string;
  sessionId?: string;
  config?: DynamicSkillsConfig;
  /** Injected monotonic clock (tests). */
  now?: () => number;
  wallNow?: () => number;
  scanner?: RepositoryScanner;
  adapter?: BaseHarnessAdapter;
  env?: NodeJS.ProcessEnv;
}

export interface StartInput {
  task: TaskIntent;
  forceGenerate?: boolean;
}

export interface CompileInput {
  draft?: unknown;
  deterministic?: boolean;
  hostBehaviouralResult?: BehaviouralEvalResult;
}

function defaultSessionId(env: NodeJS.ProcessEnv): string {
  const explicit = env.DYNAMIC_SKILLS_SESSION_ID ?? env.CLAUDE_SESSION_ID ?? env.CODEX_SESSION_ID ?? env.OPENCODE_SESSION_ID;
  if (explicit && /^[A-Za-z0-9_-]{1,80}$/.test(explicit)) return explicit;
  return `sess_${new Date().toISOString().slice(0, 10)}`;
}

/**
 * Coordinates the generation lifecycle (§4) as a sequence of request-response bridge steps (§3.2).
 * The root agent performs semantic analysis and skill drafting with its own LLM; the core does
 * everything deterministic and owns state, budget and evaluation.
 */
export class Orchestrator {
  readonly root: string;
  readonly harness: HarnessId;
  private readonly opts: OrchestratorOptions;
  private readonly runs: RunStore;
  private readonly artifacts: ArtifactStore;
  private adapterInstance?: BaseHarnessAdapter;

  constructor(opts: OrchestratorOptions) {
    this.opts = opts;
    this.root = path.resolve(opts.root);
    this.harness = opts.harness;
    this.runs = new RunStore(this.root);
    this.artifacts = new ArtifactStore({ projectRoot: this.root, ...(opts.homeDir ? { homeDir: opts.homeDir } : {}) });
  }

  private adapter(sessionId?: string): BaseHarnessAdapter {
    if (this.opts.adapter) return this.opts.adapter;
    if (!this.adapterInstance) {
      const adapterOpts: AdapterOptions = {
        projectRoot: this.root,
        ...(this.opts.homeDir ? { homeDir: this.opts.homeDir } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(this.opts.env ? { env: this.opts.env } : {}),
      };
      this.adapterInstance = createAdapter(this.harness, adapterOpts);
    }
    return this.adapterInstance;
  }

  /** An adapter for another harness, sharing this run's project, home and session. */
  private adapterFor(id: HarnessId, sessionId: string): BaseHarnessAdapter {
    if (id === this.harness) return this.adapter(sessionId);
    return createAdapter(id, {
      projectRoot: this.root,
      sessionId,
      ...(this.opts.homeDir ? { homeDir: this.opts.homeDir } : {}),
      ...(this.opts.env ? { env: this.opts.env } : {}),
    });
  }

  private budgetFrom(record: RunRecord): ExecutionBudget {
    return ExecutionBudget.fromSnapshot(record.budget, {
      ...(this.opts.now ? { now: this.opts.now } : {}),
      ...(this.opts.wallNow ? { wallNow: this.opts.wallNow } : {}),
    });
  }

  private respond(record: RunRecord, budget: ExecutionBudget, status: BridgeStatus, next: string, extra: Record<string, unknown> = {}): BridgeResponse {
    return {
      status,
      runId: record.identity.runId,
      state: record.state,
      next,
      budget: {
        consumedMs: Math.round(budget.consumedMs()),
        remainingMs: Math.round(budget.remainingMs()),
        paused: budget.isPaused(),
        clarificationRoundsUsed: budget.roundsUsed,
      },
      ...extra,
    };
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  async start(input: StartInput): Promise<BridgeResponse> {
    const env = this.opts.env ?? process.env;
    const config = this.opts.config ?? (await loadConfig(this.root));
    if (config.mode === "off") {
      throw dsError("configuration", "orchestrator", "Dynamic Skills is disabled (mode: off)", {
        recoverable: true,
        fallbackAction: "Continue the task with existing capabilities.",
      });
    }
    if (!input.task.description?.trim()) {
      throw dsError("configuration", "orchestrator", "A task description is required", { recoverable: true });
    }
    const budget = new ExecutionBudget({
      maximumMs: config.execution.activeBudgetMs,
      maximumRounds: config.execution.maximumClarificationRounds,
      ...(this.opts.now ? { now: this.opts.now } : {}),
      ...(this.opts.wallNow ? { wallNow: this.opts.wallNow } : {}),
    });
    budget.start();
    const sessionId = this.opts.sessionId ?? defaultSessionId(env);
    const repo = await getRepositoryIdentity(this.root);
    const runId = newId("run");
    const record: RunRecord = {
      schemaVersion: "1.0",
      identity: {
        runId,
        sessionId,
        repositoryId: repo.repositoryId,
        ...(repo.revision ? { repositoryRevision: repo.revision } : {}),
        taskId: newId("task"),
        startedAt: isoNow(),
        deadlineAt: budget.deadlineAt(),
        activeBudgetRemainingMs: budget.remainingMs(),
      },
      root: this.root,
      harness: this.harness,
      state: "RECEIVED",
      history: [],
      task: input.task,
      config,
      budget: budget.snapshot(),
      forceGenerate: input.forceGenerate ?? false,
      existingSkills: [],
      analysisAttempts: 0,
      compileAttempts: 0,
      assumptions: [],
      metrics: { hostSubmissions: 0, targetedDiscoveryRounds: 0, timedOut: false },
      createdAt: isoNow(),
      updatedAt: isoNow(),
    };
    await this.runs.create(record);

    return this.guard(record, budget, async () => {
      // PREFLIGHT — existing skills and instructions (§13.1 evaluate skill sufficiency).
      transition(record, "PREFLIGHT");
      const adapter = this.adapter(sessionId);
      const [hostSkills, repoSkills] = await Promise.all([
        adapter.getExistingSkills().catch(() => [] as SkillInventoryItem[]),
        discoverExistingSkills(this.root, this.opts.homeDir ? { homeDir: this.opts.homeDir } : {}).catch(() => [] as SkillInventoryItem[]),
      ]);
      record.existingSkills = dedupeSkills([...hostSkills, ...repoSkills]).filter((s) => s.name !== "dynamic-skill-bootstrap");

      if (!record.forceGenerate) {
        const reuse = await this.tryReuse(record);
        if (reuse) return reuse(budget);
      }

      // DISCOVERY — programmatic, parallel, bounded (§5.1, §15.2).
      transition(record, "DISCOVERY");
      const elapsed = stopwatch();
      const scanner = this.opts.scanner ?? new RepositoryScanner();
      const limits = {
        maxFiles: config.discovery.maximumFiles,
        maxFileBytes: config.discovery.maximumFileBytes,
        maxTotalBytes: config.discovery.maximumTotalBytes,
        contextTokenBudget: config.discovery.contextTokenBudget,
        providerTimeoutMs: config.discovery.providerTimeoutMs,
        concurrency: config.discovery.parallel ? config.discovery.concurrency : 1,
      };
      const stageMs = Math.min(STAGE_BUDGET_MS.discovery, budget.remainingMs());
      const report = await withTimeout(
        (signal) => scanner.scan({ root: this.root, task: record.task, limits, maxPriority: "P1", signal }),
        stageMs,
        budget.createAbortSignal(),
      );
      const packet = await buildContextPacket({
        runId,
        task: record.task,
        root: this.root,
        repository: { repositoryId: repo.repositoryId, ...(repo.revision ? { revision: repo.revision } : {}), workingDirectory: "." },
        report,
        limits,
      });
      const registry = new EvidenceRegistry();
      registry.add(packet.evidence);
      for (const p of packetPaths(packet)) registry.registerPath(p);
      record.metrics.discoveryMs = elapsed();
      record.metrics.packetTokens = packet.estimatedTokens;
      record.metrics.packetFiles = packet.discoveryLimits.filesRead;
      // §17: remember what every packet file looked like, so changes before activation are detected.
      record.discoveryFingerprint = (
        await computeContextFingerprint({ root: this.root, repositoryId: repo.repositoryId, dependsOn: packetFilePaths(packet) })
      ).components;

      await writeJson(this.runs.fileFor(record, "packet"), packet);
      await writeJson(this.runs.fileFor(record, "registry"), registry.toJSON());

      transition(record, "CONTEXT_ANALYSIS");
      return this.awaitingAnalysis(record, budget, packet, {
        ...(record.revisionOf
          ? {
              revision: {
                ...record.revisionOf,
                note: `This run revises the saved skill "${record.revisionOf.name}" (v${record.revisionOf.previousVersion} → v${record.revisionOf.nextVersion}) because its context changed.`,
              },
            }
          : {}),
        discovery: {
          providers: report.providers.map((p) => ({ id: p.providerId, status: p.status, evidence: p.evidenceCount })),
          evidence: packet.evidence.length,
          filesRead: packet.discoveryLimits.filesRead,
          truncated: packet.discoveryLimits.truncated,
        },
      });
    });
  }

  async analyze(runId: string, input: unknown): Promise<BridgeResponse> {
    return this.command(runId, "analyze", input, async (record, budget) => {
      this.expectState(record, "CONTEXT_ANALYSIS", "analyze");
      record.metrics.hostSubmissions++;
      const packet = await readJson<ContextPacket>(this.runs.fileFor(record, "packet"));
      const outcome = validateContextAnalysisResult(input, packet);
      if (!outcome.valid || !outcome.value) {
        record.analysisAttempts++;
        if (record.analysisAttempts >= MAX_ANALYSIS_ATTEMPTS) {
          return this.degrade(record, budget, "schema", "context-analyzer", "Context Analysis Result stayed invalid after bounded correction attempts");
        }
        return this.respond(record, budget, "invalid_input", `Fix the listed issues and resubmit with \`dynskills run analyze ${runId} --input <file>\` (${MAX_ANALYSIS_ATTEMPTS - record.analysisAttempts} attempt(s) left).`, {
          issues: outcome.issues,
          schemaPath: schemaPath("context-analysis-result"),
        });
      }
      const analysis = outcome.value;
      await writeJson(this.runs.fileFor(record, "analysis"), analysis);

      const registry = EvidenceRegistry.fromJSON(await readJson(this.runs.fileFor(record, "registry")));
      for (const e of analysis.evidence) {
        registry.recordClaim({ claim: e.claim, source: e.source, classification: e.type, origin: "analysis" });
      }
      for (const c of analysis.conflicts) {
        registry.recordClaim({ claim: c.subject, source: c.sources[0] ?? ".", classification: "conflicting", origin: "analysis" });
      }
      await writeJson(this.runs.fileFor(record, "registry"), registry.toJSON());

      const gaps = this.computeGaps(record, analysis, packet);

      // Targeted discovery (§5.5) — bounded rounds, only required requests.
      const requests: ContextRequest[] = [
        ...(analysis.additionalContextRequests ?? []).filter((r) => r.priority === "required"),
        ...gaps.gaps.filter((g) => g.resolution === "targeted_discovery" && g.contextRequest).map((g) => g.contextRequest as ContextRequest),
      ];
      if (requests.length > 0 && record.metrics.targetedDiscoveryRounds < MAX_TARGETED_DISCOVERY_ROUNDS && budget.remainingMs() > STAGE_BUDGET_MS.analysis / 3) {
        record.metrics.targetedDiscoveryRounds++;
        const limits = this.limits(record.config);
        const { packet: updated, fulfilled, rejected } = await withTimeout(
          () => applyContextRequests({ packet, requests: dedupeRequests(requests), root: this.root, limits }),
          Math.min(STAGE_BUDGET_MS.discovery / 2, budget.remainingMs()),
          budget.createAbortSignal(),
        );
        if (fulfilled.length > 0) {
          const added = packetFilePaths(updated).filter((p) => !(`file:${p}` in (record.discoveryFingerprint ?? {})));
          if (added.length > 0) {
            const fp = await computeContextFingerprint({ root: this.root, repositoryId: record.identity.repositoryId, dependsOn: added });
            record.discoveryFingerprint = { ...(record.discoveryFingerprint ?? {}), ...fp.components };
          }
          for (const p of packetPaths(updated)) registry.registerPath(p);
          registry.add(updated.evidence);
          await writeJson(this.runs.fileFor(record, "registry"), registry.toJSON());
          await writeJson(this.runs.fileFor(record, "packet"), updated);
          transition(record, "CONTEXT_ANALYSIS", "targeted discovery");
          return this.awaitingAnalysis(record, budget, updated, {
            targetedDiscovery: { fulfilled, rejected },
            note: "The packet was extended with the requested context. Update your analysis and resubmit it.",
          });
        }
      }

      return this.afterGaps(record, budget, analysis, packet, gaps);
    });
  }

  async clarify(runId: string, input: unknown): Promise<BridgeResponse> {
    return this.command(runId, "clarify", input, async (record, budget) => {
      this.expectState(record, "CLARIFICATION_PENDING", "clarify");
      const request = record.pendingClarification;
      if (!request) throw dsError("invalid_state", "orchestrator", "No pending clarification request", { runId, recoverable: false });
      const outcome = validateClarificationResponse(input, request);
      if (!outcome.valid || !outcome.value) {
        return this.respond(record, budget, "invalid_input", `Fix the listed issues and resubmit with \`dynskills run clarify ${runId} --input <file>\`. The SLA stays paused.`, {
          issues: outcome.issues,
          request,
        });
      }
      budget.resume();
      const manager = new ClarificationManager({
        maximumRounds: record.config.execution.maximumClarificationRounds,
        ...(record.clarification ? { state: record.clarification } : {}),
      });
      const { answered, assumptions } = manager.recordResponse(outcome.value);
      record.clarification = manager.toJSON();
      record.assumptions = mergeAssumptions(record.assumptions, assumptions);
      const byId = new Map(request.questions.map((q) => [q.id, q]));
      const clarified = answered
        .filter((a) => a.status === "answered" && a.answer)
        .map((a) => `User clarified — ${byId.get(a.questionId)?.question ?? a.questionId}: ${a.answer}`);
      record.task = { ...record.task, constraints: [...(record.task.constraints ?? []), ...clarified] };
      delete record.pendingClarification;

      transition(record, "CONTEXT_ANALYSIS", `clarification round ${request.round} answered`);
      const analysis = await readJson<ContextAnalysisResult>(this.runs.fileFor(record, "analysis"));
      const packet = await readJson<ContextPacket>(this.runs.fileFor(record, "packet"));
      const gaps = this.computeGaps(record, analysis, packet);
      return this.afterGaps(record, budget, analysis, packet, gaps);
    });
  }

  async compile(runId: string, input: CompileInput): Promise<BridgeResponse> {
    return this.command(runId, "compile", input, async (record, budget) => {
      this.expectState(record, "COMPILATION", "compile");
      const request = await readJson<SkillCompilationRequest>(this.runs.fileFor(record, "compilationRequest"));
      const packet = await readJson<ContextPacket>(this.runs.fileFor(record, "packet"));
      const registry = EvidenceRegistry.fromJSON(await readJson(this.runs.fileFor(record, "registry")));
      const knownReferences = new Set<string>([
        ...registry.all().map((e) => e.id),
        ...registry.sources(),
        ...record.assumptions.map((a) => a.id),
      ]);
      const elapsed = stopwatch();
      record.compileAttempts++;

      let draft: SkillDraft;
      if (input.deterministic) {
        record.metrics.deterministicCompile = true;
        draft = compileDeterministicDraft(request, packet);
      } else {
        record.metrics.hostSubmissions++;
        const outcome = validateSkillDraft(input.draft, { runId, knownReferences, requireEvidence: request.compilationPolicy.requireEvidence });
        if (!outcome.valid || !outcome.value) {
          return this.revisionOrFail(record, budget, outcome.issues.map((i) => `${i.path}: ${i.message}`), "GENERATION_EVAL_SKIPPED");
        }
        draft = outcome.value;
      }

      const revisionNotes: string[] = [];
      if (record.revisionOf && draft.name !== record.revisionOf.name) {
        revisionNotes.push(`Renamed "${draft.name}" to "${record.revisionOf.name}" so it revises the saved skill.`);
        draft = { ...draft, name: record.revisionOf.name };
      }
      const existingNames = this.competingSkills(record).map((s) => s.name);
      // §8.6: deterministic fixes are applied before evaluation, so a failure afterwards needs the host LLM.
      const fixed = applyDeterministicFixes(draft, { existingNames });
      fixed.fixes.push(...revisionNotes);
      await writeJson(this.runs.fileFor(record, "draft"), fixed.draft);
      record.skillVersion = record.revisionOf?.nextVersion ?? "1.0.0";

      transition(record, "GENERATION_EVAL");
      const analysis = await readJson<ContextAnalysisResult>(this.runs.fileFor(record, "analysis"));
      const fingerprintInputs = this.fingerprintInputs(packet, fixed.draft);
      const fingerprint = await computeContextFingerprint({ root: this.root, repositoryId: record.identity.repositoryId, ...fingerprintInputs });
      const skill: GeneratedSkill = renderSkill(fixed.draft, {
        repositoryId: record.identity.repositoryId,
        contextFingerprint: fingerprint.overall,
        evidenceIds: registry.all().map((e) => e.id),
        assumptions: record.assumptions,
        skillVersion: record.skillVersion,
      });
      record.metrics.compilationMs = (record.metrics.compilationMs ?? 0) + elapsed();

      const evalContext: EvalContext = {
        task: record.task,
        analysis,
        knownEvidenceIds: new Set(registry.all().map((e) => e.id)),
        knownPaths: registry.sources(),
        assumptionIds: new Set(record.assumptions.map((a) => a.id)),
        existingSkills: this.competingSkills(record),
        repositoryInstructions: packet.instructions.map((i) => i.content ?? "").filter(Boolean),
        policy: request.compilationPolicy,
        evidenceClaims: registry.all().map((e) => `${e.claim} ${typeof e.value === "object" ? JSON.stringify(e.value) : String(e.value ?? "")}`),
      };
      const evalCase = createBehaviouralEvalCase({ task: record.task, analysis, draft: fixed.draft });
      await writeJson(this.runs.fileFor(record, "evalCase"), evalCase);
      const evalTimer = stopwatch();
      const report = await withTimeout(
        () =>
          evaluateSkill({
            runId,
            skill,
            context: evalContext,
            evalCase,
            assumptions: record.assumptions,
            behaviouralRequired: record.config.evaluation.behaviouralSmokeEval === "required",
            ...(input.hostBehaviouralResult ? { hostBehaviouralResult: input.hostBehaviouralResult } : {}),
          }),
        Math.min(STAGE_BUDGET_MS.evaluation, budget.remainingMs()),
        budget.createAbortSignal(),
      );
      record.metrics.evaluationMs = (record.metrics.evaluationMs ?? 0) + evalTimer();
      await writeJson(this.runs.fileFor(record, "evaluation"), report);
      record.evaluation = { status: report.status, artifactHash: report.artifactHash, tokenCount: report.tokenCount, revisionHints: report.revisionHints };

      const generationFailed = Object.values(report.generation).some((r) => r.mandatory && r.status === "fail");
      if (generationFailed) return this.revisionOrFail(record, budget, report.revisionHints, "GENERATION_EVAL", report);
      transition(record, "BEHAVIOURAL_EVAL");
      if (report.status === "fail") return this.revisionOrFail(record, budget, report.revisionHints, "BEHAVIOURAL_EVAL", report);
      transition(record, "READY");

      // Stage the evaluated artifact, then activate exactly that version (§9.4, §16.3).
      const stagedDir = await this.artifacts.stageSkill(record.identity.sessionId, runId, skill);
      if (!(await this.artifacts.verifyHash(stagedDir, report.artifactHash)) || skill.artifactHash !== report.artifactHash) {
        transition(record, "ACTIVATION");
        return this.fail(record, budget, "activation", "activation", "Staged artifact hash does not match the evaluated version", { stagedDir });
      }
      record.skill = { name: skill.name, skillId: skill.skillId, artifactHash: skill.artifactHash, stagedDir, tokenCount: skill.tokenCount };
      if (record.config.evaluation.baselineComparison === "always") {
        record.baseline = compareWithBaseline({ skill, evalCase, baselineTexts: evalContext.repositoryInstructions, trigger: "always" });
      }

      transition(record, "ACTIVATION");
      // §17: if files the skill relies on changed since discovery, its evidence is stale — don't activate.
      const changes = await this.repositoryChanges(record, fingerprintInputs.dependsOn);
      record.uncitedChanges = changes.uncited;
      if (changes.cited.length > 0) {
        return this.fail(record, budget, "repository_changed", "orchestrator", `Files the skill relies on changed during generation: ${changes.cited.join(", ")}`, {
          changedFiles: changes.cited,
          stagedDir,
          fallbackAction: "Start a new run so discovery sees the current files, or continue the task with existing capabilities.",
        });
      }
      const activationTimer = stopwatch();
      const activation = record.revisionOf
        ? await this.activateRevisionByInjection(record, skill, stagedDir)
        : await withTimeout(
            () => this.adapter(record.identity.sessionId).loadSkillForSession(skill),
            Math.max(1, Math.min(STAGE_BUDGET_MS.activation, budget.remainingMs())),
            budget.createAbortSignal(),
          );
      record.metrics.activationMs = activationTimer();
      if (!activation.success || activation.artifactHash !== report.artifactHash) {
        return this.fail(record, budget, "activation", "activation", activation.message ?? "Harness could not activate the skill", {
          stagedDir,
          evaluation: summarizeReport(report),
        });
      }
      const { instructions, ...activationMeta } = activation;
      record.activation = activationMeta;
      transition(record, "ACTIVE");
      transition(record, "PERSISTENCE_PENDING");
      record.metrics.activeMs = budget.consumedMs();
      return this.respond(
        record,
        budget,
        "active",
        [
          "Apply the skill instructions below to the original task now and resume it.",
          activation.requiresReload ? `The harness needs a reload before it lists the skill: ${reloadInstruction(activation)}` : "",
          activation.invocationHint ?? "",
          `After the task, ask the user whether to keep the skill (project / global / temporary / discard) and run \`dynskills run persist ${runId} --choice <project|personal|ephemeral|discard>\`.`,
        ]
          .filter(Boolean)
          .join(" "),
        {
          skill: { name: skill.name, skillId: skill.skillId, installedPath: activation.installedPath, tokenCount: skill.tokenCount },
          instructions,
          requiresReload: activation.requiresReload ?? false,
          ...(activation.requiresReload ? { reloadInstruction: reloadInstruction(activation) } : {}),
          invocationHint: activation.invocationHint,
          evaluation: summarizeReport(report),
          deterministicFixes: fixed.fixes,
          assumptions: record.assumptions,
          lifetime: "ephemeral",
          skillVersion: record.skillVersion,
          ...(record.revisionOf ? { revision: record.revisionOf } : {}),
          ...(record.baseline ? { baseline: record.baseline } : {}),
          ...(changes.uncited.length > 0 ? { repositoryChanges: { uncited: changes.uncited, note: "These files changed during generation but the skill does not rely on them." } } : {}),
        },
      );
    });
  }

  /**
   * §10.4 persistence (explicit user choice). Project/personal saves write the canonical bundle
   * (§10.5) and install identical copies into every chosen harness, record a §8.3 baseline
   * comparison on promotion, and keep version history when a revision replaces a saved skill.
   */
  async persist(runId: string, choice: PersistenceChoice, opts: { harnesses?: HarnessId[] } = {}): Promise<BridgeResponse> {
    return this.command(runId, "persist", { choice, harnesses: opts.harnesses ?? null }, async (record, budget) => {
      if (record.state !== "PERSISTENCE_PENDING" && record.state !== "ACTIVE") this.expectState(record, "PERSISTENCE_PENDING", "persist");
      if (!record.skill) throw dsError("invalid_state", "orchestrator", "Run has no activated skill", { runId, recoverable: false });
      const adapter = this.adapter(record.identity.sessionId);
      const files = await this.artifacts.readSkillDir(record.skill.stagedDir);
      if (hashSkillFiles(files) !== record.skill.artifactHash) {
        throw dsError("security", "storage", "Staged artifact changed after evaluation; refusing to persist", {
          runId,
          recoverable: false,
          fallbackAction: "Discard this run and generate the skill again.",
        });
      }
      const draft = await readJson<SkillDraft>(this.runs.fileFor(record, "draft"));
      const skillVersion = record.skillVersion ?? "1.0.0";
      const skill: GeneratedSkill = {
        skillId: record.skill.skillId,
        name: record.skill.name,
        description: draft.description,
        files,
        artifactHash: record.skill.artifactHash,
        tokenCount: record.skill.tokenCount,
        provenance: {
          runId,
          repositoryId: record.identity.repositoryId,
          generatorVersion: GENERATOR_VERSION,
          skillVersion,
          contextFingerprint: "",
          evidenceIds: [],
          assumptionIds: record.assumptions.map((a) => a.id),
          createdAt: record.createdAt,
        },
      };
      const harnesses = [...new Set<HarnessId>([this.harness, ...(opts.harnesses ?? [])])];
      const installs: CanonicalBundleRecord["installs"] = [];
      let savedPath: string | undefined;
      try {
        if (choice === "project" || choice === "personal") {
          const packet = await readJson<ContextPacket>(this.runs.fileFor(record, "packet"));
          const fpInputs = this.fingerprintInputs(packet, draft);
          const fingerprint = await computeContextFingerprint({ root: this.root, repositoryId: record.identity.repositoryId, ...fpInputs });
          skill.provenance.contextFingerprint = fingerprint.overall;
          const evaluation = await readJson<CanonicalBundleRecord["evaluation"]>(this.runs.fileFor(record, "evaluation"));
          const evalCase = await readJsonIfExists<BehaviouralEvalCase>(this.runs.fileFor(record, "evalCase"));
          if (evalCase && record.config.evaluation.baselineComparison !== "never") {
            record.baseline = compareWithBaseline({
              skill,
              evalCase,
              baselineTexts: packet.instructions.map((i) => i.content ?? "").filter(Boolean),
              trigger: record.revisionOf ? "revision" : "promotion",
            });
          }
          const existing = await this.artifacts.loadBundle(skill.name, choice).catch(() => undefined);
          const now = isoNow();
          const history = existing && existing.record.artifactHash !== skill.artifactHash
            ? [
                {
                  skillVersion: existing.record.skillVersion,
                  artifactHash: existing.record.artifactHash,
                  replacedAt: now,
                  reason: record.revisionOf ? `${record.revisionOf.decision}: ${record.revisionOf.reasons.join("; ") || "context changed"}` : "replaced by a new generation",
                },
                ...(existing.record.history ?? []),
              ]
            : existing?.record.history;

          // Activation and persistence are separate (ADR-005): drop the session install, then save.
          if (!record.revisionOf) await adapter.removeSkill(skill.skillId, "ephemeral").catch(() => undefined);
          for (const id of harnesses) {
            const target = id === this.harness ? adapter : this.adapterFor(id, record.identity.sessionId);
            await target.saveSkill(skill, choice);
            installs.push({ harness: id, scope: choice, path: path.join(target.skillsDirFor(choice), skill.name), artifactHash: skill.artifactHash, installedAt: now });
          }
          // §10.5: every installed copy must be byte-identical to the canonical artifact.
          for (const inst of installs) {
            if (hashSkillFiles(await this.artifacts.readSkillDir(inst.path)) !== skill.artifactHash) {
              throw dsError("persistence", "storage", `Installed copy for ${inst.harness} differs from the canonical artifact`, { runId, recoverable: true });
            }
          }
          const bundle: CanonicalBundleRecord = {
            skillId: skill.skillId,
            name: skill.name,
            artifactHash: skill.artifactHash,
            skillVersion,
            generatorVersion: GENERATOR_VERSION,
            repositoryId: choice === "personal" ? "*" : record.identity.repositoryId,
            contextFingerprint: fingerprint,
            evaluation,
            createdAt: existing?.record.createdAt ?? now,
            updatedAt: now,
            lifecycleStatus: "persisted",
            installs,
            dependsOn: fpInputs.dependsOn,
            task: record.task.description,
            ...(record.baseline ? { baseline: record.baseline } : {}),
            ...(history?.length ? { history } : {}),
          };
          savedPath = await this.artifacts.saveCanonical(skill, bundle, choice, { overwrite: !!existing });
        } else if (choice === "discard") {
          if (!record.revisionOf) await adapter.removeSkill(skill.skillId, "ephemeral").catch(() => undefined);
          await rm(record.skill.stagedDir, { recursive: true, force: true });
        }
      } catch (err) {
        // §17: persistence failure keeps the skill ephemeral.
        record.persistence = { choice: "ephemeral" };
        transition(record, "COMPLETED", `persistence failed: ${errorMessage(err)}`);
        return this.respond(record, budget, "completed", "Persistence failed; the skill stays ephemeral for this session.", {
          persistenceError: err instanceof DynamicSkillsError ? err.info : { message: errorMessage(err) },
          ...(installs.length ? { partialInstalls: installs } : {}),
        });
      }
      record.persistence = { choice, ...(savedPath ? { path: savedPath } : {}) };
      transition(record, "COMPLETED", `persistence: ${choice}`);
      const where = installs.map((i) => i.harness).join(", ");
      const revised = record.revisionOf ? ` as v${skillVersion} (replacing v${record.revisionOf.previousVersion})` : ` as v${skillVersion}`;
      const messages: Record<PersistenceChoice, string> = {
        project: `Saved in this project${revised} for ${where}. It will be reused for similar tasks after a freshness check.`,
        personal: `Saved globally for this user${revised} for ${where}.`,
        ephemeral: record.revisionOf
          ? "Kept for this session only; the saved version is unchanged."
          : "Kept temporarily; `dynskills clean` removes it after the retention period.",
        discard: record.revisionOf ? "Discarded the revision; the saved version is unchanged." : "Discarded and removed from the session.",
      };
      const baselineNote =
        record.baseline && record.baseline.verdict !== "improves"
          ? ` Baseline check: the skill adds no measurable coverage over the repository's own instructions (lift ${record.baseline.lift}); consider discarding it.`
          : "";
      return this.respond(record, budget, "completed", messages[choice] + baselineNote, {
        persistence: record.persistence,
        skillVersion,
        ...(installs.length ? { installs } : {}),
        ...(record.baseline ? { baseline: record.baseline } : {}),
      });
    });
  }

  async status(runId: string): Promise<BridgeResponse> {
    const record = await this.runs.load(runId);
    const budget = this.budgetFrom(record);
    const cmd = expectedCommand(record.state);
    return this.respond(record, budget, "status", cmd ? `Run is waiting for \`dynskills run ${cmd} ${runId}\`.` : "Run is finished.", {
      task: record.task.description,
      history: record.history,
      skill: record.skill,
      evaluation: record.evaluation,
      persistence: record.persistence,
      error: record.error,
      metrics: record.metrics,
    });
  }

  async cancel(runId: string): Promise<BridgeResponse> {
    return this.command(runId, "cancel", null, async (record, budget) => {
      if (TERMINAL_STATES.has(record.state)) return this.respond(record, budget, "status", "Run already finished.");
      if (record.state === "ACTIVE" || record.state === "PERSISTENCE_PENDING") return this.persistNow(record, budget);
      if (budget.isPaused()) budget.resume();
      return this.degrade(record, budget, "invalid_state", "orchestrator", "Cancelled by the root agent");
    });
  }

  private async persistNow(record: RunRecord, budget: ExecutionBudget): Promise<BridgeResponse> {
    await this.adapter(record.identity.sessionId).removeSkill(record.skill?.skillId ?? "", "ephemeral").catch(() => undefined);
    record.persistence = { choice: "discard" };
    transition(record, "COMPLETED", "cancelled");
    return this.respond(record, budget, "completed", "Cancelled; the session skill was removed.");
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private limits(config: DynamicSkillsConfig) {
    return {
      maxFiles: config.discovery.maximumFiles,
      maxFileBytes: config.discovery.maximumFileBytes,
      maxTotalBytes: config.discovery.maximumTotalBytes,
      contextTokenBudget: config.discovery.contextTokenBudget,
      providerTimeoutMs: config.discovery.providerTimeoutMs,
      concurrency: config.discovery.parallel ? config.discovery.concurrency : 1,
    };
  }

  private computeGaps(record: RunRecord, analysis: ContextAnalysisResult, packet: ContextPacket) {
    const asked = record.clarification?.askedQuestions ?? [];
    const declined = record.clarification?.declinedQuestions ?? [];
    const gaps = analyzeContextGaps({
      task: record.task,
      analysis,
      packet,
      existingSkills: record.existingSkills,
      previouslyAsked: asked,
      declined,
    });
    record.gaps = gaps;
    return gaps;
  }

  private async afterGaps(
    record: RunRecord,
    budget: ExecutionBudget,
    analysis: ContextAnalysisResult,
    packet: ContextPacket,
    gaps: ReturnType<typeof analyzeContextGaps>,
  ): Promise<BridgeResponse> {
    const manager = new ClarificationManager({
      maximumRounds: record.config.execution.maximumClarificationRounds,
      ...(record.clarification ? { state: record.clarification } : {}),
    });
    if (gaps.requiresClarification) {
      const request = manager.canAskMore()
        ? manager.buildRequest(record.identity.runId, gaps.gaps, `Task: ${record.task.description}`)
        : undefined;
      if (request) {
        budget.pause("human_clarification");
        record.clarification = manager.toJSON();
        record.pendingClarification = request;
        await writeJson(this.runs.fileFor(record, "clarificationRequest"), request);
        transition(record, "CLARIFICATION_PENDING", `round ${request.round}`);
        return this.respond(
          record,
          budget,
          "awaiting_clarification",
          `Ask the user these questions in ONE native interaction, then submit {runId, round, answers:[{questionId, answer?, status}]} with \`dynskills run clarify ${record.identity.runId} --input <file>\`. The SLA is paused while you wait for the user.`,
          { request, schemaPath: schemaPath("clarification-response") },
        );
      }
      if (!manager.canAskMore()) record.assumptions = mergeAssumptions(record.assumptions, manager.finalizeAtRoundLimit(gaps.gaps));
    }
    record.assumptions = mergeAssumptions(record.assumptions, manager.documentAssumptions(gaps.gaps));
    record.clarification = manager.toJSON();

    transition(record, "COMPILATION");
    const request = buildCompilationRequest({
      runId: record.identity.runId,
      task: record.task,
      analysis,
      gaps: gaps.gaps,
      assumptions: record.assumptions,
      existingSkills: this.competingSkills(record),
      config: record.config,
    });
    await writeJson(this.runs.fileFor(record, "compilationRequest"), request);
    let prompt = buildCompilationPrompt(request, {
      evidenceIds: packet.evidence.map((e) => e.id),
      skillDraftSchemaPath: schemaPath("skill-draft"),
    });
    if (record.revisionOf) prompt += await this.revisionPromptSection(record);
    const promptPath = this.runs.fileFor(record, "compilePrompt");
    await writeFileAtomic(promptPath, prompt);
    return this.respond(
      record,
      budget,
      "awaiting_skill_draft",
      `Read the prompt at promptPath, write a SkillDraft JSON, and submit it with \`dynskills run compile ${record.identity.runId} --input <file>\`. ${draftGuidance(budget.remainingMs(), record.identity.runId)}`,
      { promptPath, schemaPath: schemaPath("skill-draft"), assumptions: record.assumptions, gaps: gaps.gaps },
    );
  }

  private async revisionOrFail(
    record: RunRecord,
    budget: ExecutionBudget,
    hints: string[],
    at: "GENERATION_EVAL" | "BEHAVIOURAL_EVAL" | "GENERATION_EVAL_SKIPPED",
    report?: Awaited<ReturnType<typeof evaluateSkill>>,
  ): Promise<BridgeResponse> {
    const maxAttempts = record.config.execution.maximumRevisionAttempts + 1;
    const canRevise = report
      ? planRevision({
          report,
          attemptsUsed: record.compileAttempts - 1,
          maximumAttempts: record.config.execution.maximumRevisionAttempts,
          remainingMs: budget.remainingMs(),
          deterministicFixApplied: true,
        }).action === "llm_revision"
      : record.compileAttempts < maxAttempts && budget.remainingMs() >= 8_000;
    if (at !== "GENERATION_EVAL_SKIPPED") transition(record, canRevise ? "COMPILATION" : "FAILED", canRevise ? "revision required" : "mandatory evaluation failed");
    if (!canRevise) {
      if (at === "GENERATION_EVAL_SKIPPED") transition(record, "FAILED", "invalid skill draft");
      return this.fail(record, budget, "evaluation", "eval-engine", "Mandatory evaluation failed and no revision budget remains; the skill was not activated", {
        hints,
        ...(report ? { evaluation: summarizeReport(report) } : {}),
      }, true);
    }
    return this.respond(
      record,
      budget,
      "revision_required",
      `Revise the SkillDraft to address every hint and resubmit once with \`dynskills run compile ${record.identity.runId} --input <file>\`. ${draftGuidance(budget.remainingMs(), record.identity.runId)}`,
      { hints, ...(report ? { evaluation: summarizeReport(report) } : {}), attemptsLeft: maxAttempts - record.compileAttempts },
    );
  }

  /**
   * Preflight (§13.1, §10.6). Skills that Dynamic Skills manages are judged by freshness, never by
   * name alone: a fresh one is reused, a stale one is revised by this run (augment → minor version,
   * regenerate → major version). Other existing skills are reused when they are sufficient.
   */
  private async tryReuse(record: RunRecord): Promise<((b: ExecutionBudget) => BridgeResponse) | undefined> {
    const listed = [
      ...(await this.artifacts.listBundles("project").catch(() => [])).map((b) => ({ bundle: b, scope: "project" as const })),
      ...(await this.artifacts.listBundles("personal").catch(() => [])).map((b) => ({ bundle: b, scope: "personal" as const })),
    ];
    const managed = new Set(listed.map((x) => x.bundle.name));

    const sufficiency = assessSkillSufficiency(record.task, record.existingSkills.filter((s) => !managed.has(s.name)));
    if (sufficiency.sufficient) {
      const skills = sufficiency.matches.filter((m) => m.score > 0).slice(0, 3).map((m) => m.skill);
      record.reusedSkills = skills;
      transition(record, "REUSE_EXISTING", "existing skill sufficient");
      return (b) =>
        this.respond(record, b, "reuse_existing", `Existing expertise is sufficient: load ${skills.map((s) => `"${s.name}"`).join(", ")} with your native skill mechanism and continue the task.`, {
          skills,
        });
    }

    const candidates = findReusableBundles({
      taskDescription: record.task.description,
      bundles: listed.map((x) => x.bundle),
      repositoryId: record.identity.repositoryId,
    }).filter((b) => assessSkillSufficiency(record.task, [{ name: b.name, description: b.task, path: b.name, scope: "unknown" }]).sufficient);

    for (const bundle of candidates.slice(0, 2)) {
      const scope = listed.find((x) => x.bundle === bundle)?.scope ?? "project";
      const current = await computeContextFingerprint({
        root: this.root,
        repositoryId: bundle.repositoryId,
        dependsOn: bundle.dependsOn,
        // Facts are derived from manifest files that dependsOn already covers (see fingerprintInputs),
        // so carrying the recorded facts forward compares only what preflight can observe: file content.
        facts: Object.fromEntries(
          Object.entries(bundle.contextFingerprint.components)
            .filter(([k]) => k.startsWith("fact:"))
            .map(([k, v]) => [k.slice(5), v]),
        ),
      });
      const freshness = assessFreshness(bundle, current);
      if (freshness.decision === "reuse") {
        const skillItem: SkillInventoryItem = { name: bundle.name, description: bundle.task, path: bundle.installs[0]?.path ?? "", scope };
        record.reusedSkills = [skillItem];
        transition(record, "REUSE_EXISTING", `fresh bundle ${bundle.name}`);
        return (b) =>
          this.respond(record, b, "reuse_existing", `A previously generated skill "${bundle.name}" is still fresh: load it with your native skill mechanism and continue.`, {
            skills: [skillItem],
            freshness,
          });
      }
      if (!record.revisionOf) {
        const decision = freshness.decision;
        record.revisionOf = {
          name: bundle.name,
          scope,
          previousVersion: bundle.skillVersion,
          nextVersion: nextSkillVersion(bundle.skillVersion, decision === "augment" ? "minor" : "major"),
          previousArtifactHash: bundle.artifactHash,
          decision,
          reasons: freshness.reasons,
          changedComponents: freshness.changedComponents,
        };
      }
    }
    return undefined;
  }

  /** Existing skills a new skill must not collide with; the skill being revised is not a competitor. */
  private competingSkills(record: RunRecord): SkillInventoryItem[] {
    const revising = record.revisionOf?.name;
    return revising ? record.existingSkills.filter((s) => s.name !== revising) : record.existingSkills;
  }

  private async revisionPromptSection(record: RunRecord): Promise<string> {
    const rev = record.revisionOf;
    if (!rev) return "";
    const loaded = await this.artifacts.loadBundle(rev.name, rev.scope).catch(() => undefined);
    const previous = loaded?.files.find((f) => f.path === "SKILL.md")?.content;
    const lines = [
      "",
      "## Revision of an existing skill",
      `This run revises the saved skill "${rev.name}" (v${rev.previousVersion} → v${rev.nextVersion}). Use exactly this name.`,
      `Freshness decision: ${rev.decision}. Why: ${rev.reasons.join("; ") || "context changed"}.`,
      rev.changedComponents.length ? `Changed since it was saved: ${rev.changedComponents.join(", ")}.` : "",
      rev.decision === "augment"
        ? "Keep what is still true and update only what the changes affect; cite current evidence for every constraint."
        : "Treat the previous version as untrusted history: rebuild every constraint from current evidence.",
    ];
    if (previous && rev.decision === "augment") lines.push("", "Previous SKILL.md (for reference, not as evidence):", "```markdown", previous, "```");
    return `${lines.filter((l) => l !== "").join("\n")}\n`;
  }

  /**
   * §17: compare files against their discovery-time hashes. Changes to files the skill relies on
   * (`cited`) block activation; other changed packet files are only reported.
   */
  private async repositoryChanges(record: RunRecord, dependsOn: string[]): Promise<{ cited: string[]; uncited: string[] }> {
    const baseline = record.discoveryFingerprint ?? {};
    const files = Object.keys(baseline).map((k) => k.slice("file:".length));
    if (files.length === 0) return { cited: [], uncited: [] };
    const current = await computeContextFingerprint({ root: this.root, repositoryId: record.identity.repositoryId, dependsOn: files });
    const changed = files.filter((f) => current.components[`file:${f}`] !== baseline[`file:${f}`]);
    const relied = new Set(dependsOn);
    return { cited: changed.filter((f) => relied.has(f)), uncited: changed.filter((f) => !relied.has(f)) };
  }

  /**
   * A revision must not overwrite the saved copy before the user approves (ADR-005), and the
   * activator refuses to replace a persisted skill. So the revised version reaches the session
   * through current-turn instruction injection (§9.2 strategy 3); the saved copy changes on persist.
   */
  private async activateRevisionByInjection(record: RunRecord, skill: GeneratedSkill, stagedDir: string): Promise<ActivationResult> {
    const verified = await this.artifacts.verifyHash(stagedDir, skill.artifactHash);
    const content = skill.files.find((f) => f.path === "SKILL.md")?.content;
    if (!verified || !content) {
      return { success: false, capability: "current_turn_instruction_injection", skillId: skill.skillId, artifactHash: skill.artifactHash, message: "Revised artifact failed verification" };
    }
    return {
      success: true,
      capability: "current_turn_instruction_injection",
      skillId: skill.skillId,
      artifactHash: skill.artifactHash,
      instructions: content,
      invocationHint: `Apply these instructions directly. The saved "${skill.name}" (v${record.revisionOf?.previousVersion}) stays installed until the user persists v${record.revisionOf?.nextVersion}.`,
      message: "Revision delivered through current-turn instructions; the saved copy is unchanged until persisted.",
    };
  }

  private fingerprintInputs(packet: ContextPacket, draft: SkillDraft): { dependsOn: string[]; facts: Record<string, string> } {
    const evidenceById = new Map(packet.evidence.map((e) => [e.id, e]));
    const cited = new Set<string>();
    for (const c of draft.projectConstraints) {
      for (const ref of c.evidence) {
        const ev = evidenceById.get(ref);
        if (ev && ev.source !== ".") cited.add(ev.source);
        else if (!ref.startsWith("ev_") && !ref.startsWith("asm_")) cited.add(ref);
      }
    }
    for (const c of packet.configuration) cited.add(c.path);
    // The manifests behind technology facts, so a dependency or runtime change shows up as a file change.
    for (const e of packet.evidence) {
      if (["runtime", "framework", "package_manager", "dependency", "tooling"].includes(e.kind) && e.source !== ".") cited.add(e.source);
    }
    const facts: Record<string, string> = {};
    for (const f of packet.technology.frameworks) facts[`framework:${f.name}`] = f.version ?? "unknown";
    for (const [k, v] of Object.entries(packet.technology.runtimes)) facts[`runtime:${k}`] = v;
    return { dependsOn: [...cited].filter((p) => !isSkillPath(p)).sort().slice(0, 50), facts };
  }

  private awaitingAnalysis(record: RunRecord, budget: ExecutionBudget, packet: ContextPacket, extra: Record<string, unknown>): BridgeResponse {
    return this.respond(
      record,
      budget,
      "awaiting_analysis",
      `Read the Context Packet at packetPath and write a ContextAnalysisResult JSON (schema at schemaPath; runId "${record.identity.runId}"). Cite packet evidence ids or file paths as sources; mark inferences as "inferred". Submit with \`dynskills run analyze ${record.identity.runId} --input <file>\`.`,
      {
        packetPath: this.runs.fileFor(record, "packet"),
        schemaPath: schemaPath("context-analysis-result"),
        packetSummary: {
          languages: packet.technology.languages,
          frameworks: packet.technology.frameworks.map((f) => (f.version ? `${f.name}@${f.version}` : f.name)),
          evidence: packet.evidence.length,
          estimatedTokens: packet.estimatedTokens,
        },
        ...extra,
      },
    );
  }

  private expectState(record: RunRecord, state: RunRecord["state"], command: string): void {
    if (record.state === state) return;
    const expected = expectedCommand(record.state);
    throw dsError("invalid_state", "orchestrator", `Run is in ${record.state}; \`${command}\` is not valid now`, {
      runId: record.identity.runId,
      recoverable: true,
      fallbackAction: expected ? `Run \`dynskills run ${expected} ${record.identity.runId}\`.` : "The run is finished; start a new one if needed.",
    });
  }

  /** Load → lock → idempotency → SLA check → handler → persist. */
  private async command(runId: string, name: string, input: unknown, handler: (record: RunRecord, budget: ExecutionBudget) => Promise<BridgeResponse>): Promise<BridgeResponse> {
    const initial = await this.runs.load(runId);
    return this.runs.withLock(initial, async () => {
      const record = await this.runs.load(runId);
      const hash = requestHash(name, input);
      if (record.lastRequest && record.lastRequest.command === name && record.lastRequest.inputHash === hash) {
        return record.lastRequest.response as BridgeResponse; // §4.3 idempotent replay
      }
      const budget = this.budgetFrom(record);
      const stateBefore = record.state;
      const response = await this.guard(record, budget, () => handler(record, budget));
      record.lastRequest = { command: name, inputHash: hash, stateBefore, response };
      await this.runs.save(record);
      return response;
    });
  }

  /** Enforce the SLA (§15.5) and convert failures into degraded/failed responses (§17). */
  private async guard(record: RunRecord, budget: ExecutionBudget, fn: () => Promise<BridgeResponse>): Promise<BridgeResponse> {
    try {
      if (!budget.isPaused() && budget.isExpired() && !TERMINAL_STATES.has(record.state) && record.state !== "PERSISTENCE_PENDING" && record.state !== "ACTIVE") {
        record.metrics.timedOut = true;
        return this.degrade(record, budget, "sla_expired", "sla", "Active-processing budget expired");
      }
      const res = await fn();
      return res;
    } catch (err) {
      if (err instanceof TimeoutError || (budget.isExpired() && !budget.isPaused())) {
        record.metrics.timedOut = true;
        return this.degrade(record, budget, "sla_expired", "sla", `Active-processing budget expired (${errorMessage(err)})`);
      }
      if (err instanceof DynamicSkillsError && err.info.category === "invalid_state") throw err;
      // After activation the run can no longer degrade or fail (§4.1): surface the real error instead.
      if (record.state === "ACTIVE" || record.state === "PERSISTENCE_PENDING") throw err;
      if (err instanceof DynamicSkillsError && err.info.category === "configuration") throw err;
      const info = err instanceof DynamicSkillsError ? err.info : undefined;
      if (record.state === "ACTIVATION" || record.state === "COMPILATION" || record.state === "GENERATION_EVAL" || record.state === "BEHAVIOURAL_EVAL") {
        return this.fail(record, budget, info?.category ?? "internal", info?.component ?? "orchestrator", errorMessage(err));
      }
      return this.degrade(record, budget, info?.category ?? "internal", info?.component ?? "orchestrator", errorMessage(err));
    } finally {
      record.budget = budget.snapshot();
      record.identity.activeBudgetRemainingMs = Math.round(budget.remainingMs());
      record.identity.deadlineAt = budget.deadlineAt();
      await this.runs.save(record);
    }
  }

  private degrade(record: RunRecord, budget: ExecutionBudget, category: ErrorInfo["category"], component: ErrorInfo["component"], message: string): BridgeResponse {
    record.error = {
      runId: record.identity.runId,
      category,
      component,
      message,
      elapsedActiveMs: Math.round(budget.consumedMs()),
      recoverable: true,
      fallbackAction: "Continue the original task with existing capabilities; no skill was activated.",
    };
    if (!TERMINAL_STATES.has(record.state)) transition(record, "DEGRADED", message);
    record.metrics.activeMs = budget.consumedMs();
    return this.respond(record, budget, "degraded", "Stop using Dynamic Skills for this task and continue with your existing capabilities. Briefly tell the user why no skill was generated.", {
      error: record.error,
    });
  }

  private fail(
    record: RunRecord,
    budget: ExecutionBudget,
    category: ErrorInfo["category"],
    component: ErrorInfo["component"],
    message: string,
    extra: Record<string, unknown> = {},
    alreadyTransitioned = false,
  ): BridgeResponse {
    const { fallbackAction, ...rest } = extra as { fallbackAction?: string };
    extra = rest;
    record.error = {
      runId: record.identity.runId,
      category,
      component,
      message,
      elapsedActiveMs: Math.round(budget.consumedMs()),
      recoverable: fallbackAction !== undefined,
      fallbackAction: fallbackAction ?? "Continue the original task with existing capabilities. Do not apply an unvalidated skill.",
    };
    if (!alreadyTransitioned && !TERMINAL_STATES.has(record.state)) transition(record, "FAILED", message);
    record.metrics.activeMs = budget.consumedMs();
    return this.respond(record, budget, "failed", "No skill was activated. Continue the original task with your existing capabilities and briefly tell the user why.", {
      error: record.error,
      ...extra,
    });
  }

  /** Read a JSON input file (or "-" for stdin) for CLI use. */
  static async readInput(file: string): Promise<unknown> {
    const text = file === "-" ? await readStdin() : await readFile(file, "utf8");
    try {
      return JSON.parse(text);
    } catch (err) {
      throw dsError("schema", "cli", `Input is not valid JSON: ${errorMessage(err)}`, { recoverable: true, fallbackAction: "Write valid JSON and resubmit." });
    }
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Tells the host how much budget is left and when the deterministic compile is acceptable.
 * Without numbers, agents took the deterministic path with most of the budget unused (ADR-018).
 */
function draftGuidance(remainingMs: number, runId: string): string {
  const seconds = Math.floor(remainingMs / 1000);
  if (remainingMs < DETERMINISTIC_COMPILE_THRESHOLD_MS) {
    return `Only ${seconds} s of the active budget remain: if you cannot submit a draft right away, run \`dynskills run compile ${runId} --deterministic\` instead.`;
  }
  return `${seconds} s of the active budget remain, which is enough for a draft. Write the draft: it produces a project-specific skill. Use \`--deterministic\` only if fewer than ${DETERMINISTIC_COMPILE_THRESHOLD_MS / 1000} s remain or you cannot produce a valid draft; it gives a generic skill with fewer project constraints.`;
}

/** The harness-specific reload step (e.g. Claude Code's /reload-skills), carried in the activation message. */
function reloadInstruction(activation: ActivationResult): string {
  const msg = activation.message ?? "";
  const reload = msg.split(/(?<=\.)\s+/).find((sentence) => /reload|restart|refresh/i.test(sentence));
  return reload ?? "Reload or restart the session so it lists the skill.";
}

function packetPaths(packet: ContextPacket): string[] {
  return [
    ...packet.instructions.map((i) => i.path),
    ...packet.configuration.map((c) => c.path),
    ...packet.sourceFiles.map((s) => s.path),
    ...packet.existingSkills.map((s) => s.path),
    ...packet.evidence.map((e) => e.source),
  ];
}

/** Repository-relative file paths the packet was built from (no ".", no skill files, deduped). */
function packetFilePaths(packet: ContextPacket): string[] {
  return [...new Set(packetPaths(packet).filter((p) => p && p !== "." && !isSkillPath(p)))].sort().slice(0, 400);
}

/**
 * Installed skills are not project context: a skill's own SKILL.md (or a sibling skill) must not
 * make it look stale or block activation when Dynamic Skills itself writes to a skills directory.
 */
function isSkillPath(p: string): boolean {
  return /(^|\/)\.(claude|agents|opencode)\/skills?\//.test(p) || /(^|\/)\.dynamic-skills(-runtime)?\//.test(p);
}

function dedupeSkills(skills: SkillInventoryItem[]): SkillInventoryItem[] {
  const seen = new Map<string, SkillInventoryItem>();
  for (const s of skills) if (!seen.has(path.resolve(s.path))) seen.set(path.resolve(s.path), s);
  return [...seen.values()];
}

function dedupeRequests(requests: ContextRequest[]): ContextRequest[] {
  const seen = new Set<string>();
  return requests.filter((r) => {
    const k = `${r.type}|${r.path ?? ""}|${r.query ?? ""}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function mergeAssumptions(a: Assumption[], b: Assumption[]): Assumption[] {
  const map = new Map(a.map((x) => [x.id, x]));
  for (const x of b) map.set(x.id, x);
  return [...map.values()];
}

function summarizeReport(report: Awaited<ReturnType<typeof evaluateSkill>>) {
  return {
    status: report.status,
    checks: Object.fromEntries(Object.entries(report.generation).map(([k, v]) => [k, v.status])),
    behavioural: report.behavioural.status,
    tokenCount: report.tokenCount,
    durationMs: Math.round(report.durationMs),
    hints: report.revisionHints.slice(0, 10),
  };
}
