/**
 * Shared, versioned contracts between Dynamic Skills components.
 * Every other module depends on these types; change them deliberately.
 * Section references (§) point to the project's design document (not public).
 */

export const SCHEMA_VERSION = "1.0" as const;
export type SchemaVersion = typeof SCHEMA_VERSION;

export type HarnessId = "claude" | "codex" | "opencode";
export const HARNESS_IDS: readonly HarnessId[] = ["claude", "codex", "opencode"];

// ---------------------------------------------------------------------------
// §4 Lifecycle, identity
// ---------------------------------------------------------------------------

export type GenerationState =
  | "RECEIVED"
  | "PREFLIGHT"
  | "REUSE_EXISTING"
  | "DISCOVERY"
  | "CONTEXT_ANALYSIS"
  | "CLARIFICATION_PENDING"
  | "COMPILATION"
  | "GENERATION_EVAL"
  | "BEHAVIOURAL_EVAL"
  | "READY"
  | "ACTIVATION"
  | "ACTIVE"
  | "PERSISTENCE_PENDING"
  | "COMPLETED"
  | "DEGRADED"
  | "FAILED";

/** §4.3 Request identity. */
export interface RunIdentity {
  runId: string;
  sessionId: string;
  repositoryId: string;
  repositoryRevision?: string;
  taskId: string;
  /** ISO timestamp (display only; never used for elapsed-time accounting). */
  startedAt: string;
  /** ISO timestamp: projected deadline if no further pauses occur (display only). */
  deadlineAt: string;
  activeBudgetRemainingMs: number;
}

export interface TaskIntent {
  description: string;
  scope?: string[];
  expectedOutcome?: string;
  constraints?: string[];
}

// ---------------------------------------------------------------------------
// §5.1 Programmatic discovery
// ---------------------------------------------------------------------------

export type DiscoveryPriority = "P0" | "P1" | "P2";

export type EvidenceKind =
  | "language"
  | "runtime"
  | "framework"
  | "package_manager"
  | "tooling"
  | "dependency"
  | "workspace"
  | "directory"
  | "entrypoint"
  | "instructions"
  | "configuration"
  | "test_configuration"
  | "build_configuration"
  | "ci_cd"
  | "existing_skill"
  | "documentation"
  | "source_file";

/** A single deterministic fact with provenance. */
export interface DiscoveryEvidence {
  /** Deterministic id: "ev_" + first 12 hex chars of sha256(providerId|kind|source|claim). */
  id: string;
  providerId: string;
  kind: EvidenceKind;
  priority: DiscoveryPriority;
  /** Human-readable fact, e.g. "Uses TypeScript 5.4.5". */
  claim: string;
  /** Repository-relative POSIX path the fact came from ("." for the repository itself). */
  source: string;
  /** Structured value, e.g. { name: "react", version: "18.3.1" }. */
  value?: string | number | boolean | Record<string, unknown>;
  /** Short, redacted excerpt supporting the claim. */
  excerpt?: string;
  line?: number;
  /** 0..1 — deterministic parsers use 1, filename heuristics lower. */
  confidence: number;
}

export interface DiscoveryLimits {
  /** Maximum selected context files (§5.3 default 30). */
  maxFiles: number;
  /** Maximum bytes per selected text file (§5.3 default 64 KB). */
  maxFileBytes: number;
  /** Maximum bytes of assembled text content (§5.3 default 512 KB). */
  maxTotalBytes: number;
  /** Approximate context-token budget for the packet (§5.3 default 12,000). */
  contextTokenBudget: number;
  /** Per-provider timeout in ms (§15.2). */
  providerTimeoutMs: number;
  /** Bounded provider concurrency (§15.2). */
  concurrency: number;
}

export interface DiscoveryContext {
  /** Absolute repository root. Nothing outside it may be read. */
  root: string;
  task: TaskIntent;
  limits: DiscoveryLimits;
  /** Highest priority tier to run (P0 always runs; "P1" runs P0+P1; "P2" runs all). */
  maxPriority: DiscoveryPriority;
  /**
   * Repository-relative file list (default exclusions and sensitive files already removed),
   * computed once by the RepositoryScanner and shared with all providers.
   */
  fileIndex: string[];
}

/** §5.1 common scanner contract. */
export interface DiscoveryProvider {
  readonly id: string;
  readonly priority: DiscoveryPriority;
  supports(context: DiscoveryContext): boolean;
  discover(context: DiscoveryContext, signal?: AbortSignal): Promise<DiscoveryEvidence[]>;
}

export interface ProviderRunResult {
  providerId: string;
  status: "ok" | "timeout" | "error" | "skipped";
  durationMs: number;
  evidenceCount: number;
  error?: string;
}

export interface DiscoveryReport {
  evidence: DiscoveryEvidence[];
  providers: ProviderRunResult[];
  fileIndexSize: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// §5.3 Context packet
// ---------------------------------------------------------------------------

export interface ContextFile {
  path: string;
  content: string;
  truncated: boolean;
  /** Why this file was selected (e.g. "instructions", "task-relevant: matched 'payment'"). */
  reason: string;
}

export interface ContextPacket {
  schemaVersion: SchemaVersion;
  runId: string;
  task: TaskIntent;
  repository: {
    root: string;
    repositoryId?: string;
    revision?: string;
    workingDirectory?: string;
  };
  technology: {
    languages: string[];
    runtimes: Record<string, string>;
    frameworks: Array<{ name: string; version?: string; source: string }>;
    packageManagers: string[];
    tooling: string[];
  };
  structure: {
    workspaces: string[];
    relevantDirectories: string[];
    entrypoints: string[];
  };
  instructions: Array<{ path: string; content?: string }>;
  configuration: Array<{ path: string; summary?: string; content?: string }>;
  existingSkills: Array<{ name: string; description: string; path: string }>;
  /** Task-relevant source excerpts (P1). */
  sourceFiles: ContextFile[];
  evidence: DiscoveryEvidence[];
  discoveryLimits: {
    filesRead: number;
    filesSkipped: number;
    truncated: boolean;
    reasons: string[];
  };
  /** Approximate token size of the serialized packet. */
  estimatedTokens: number;
}

// ---------------------------------------------------------------------------
// §5.4 Context analysis (produced by the host agent, validated by core)
// ---------------------------------------------------------------------------

export type EvidenceClassification = "observed" | "inferred" | "assumed" | "unknown" | "conflicting";

export interface AnalysisEvidence {
  claim: string;
  /** A packet evidence id ("ev_…") or a repository-relative path present in the packet. */
  source: string;
  type: "observed" | "inferred";
  confidence?: number;
}

export interface ContextRequest {
  type: "source_file" | "configuration" | "directory_summary" | "dependency_details" | "documentation";
  path?: string;
  query?: string;
  reason: string;
  priority: "required" | "optional";
}

export interface ContextAnalysisResult {
  schemaVersion: SchemaVersion;
  runId: string;
  technology: {
    languages: string[];
    frameworks: string[];
    runtimes: string[];
    packageManagers: string[];
  };
  architecture: {
    patterns: string[];
    moduleStructure: string[];
    conventions: string[];
    dependencies: string[];
  };
  taskContext: {
    relevantComponents: string[];
    existingImplementations: string[];
    constraints: string[];
    expectedOutcome?: string;
  };
  evidence: AnalysisEvidence[];
  unknowns: Array<{ question: string; importance: "critical" | "optional" }>;
  conflicts: Array<{ subject: string; observations: string[]; sources: string[] }>;
  additionalContextRequests?: ContextRequest[];
}

export interface ValidationIssue {
  /** JSON pointer into the validated document, e.g. "/evidence/2/source". */
  path: string;
  message: string;
  severity: "error" | "warning";
}

export interface ValidationOutcome<T> {
  valid: boolean;
  value?: T;
  issues: ValidationIssue[];
}

// ---------------------------------------------------------------------------
// §5.6 Context gaps
// ---------------------------------------------------------------------------

export interface ContextGap {
  id: string;
  category: "missing_expertise" | "missing_project_context" | "ambiguous_requirement" | "conflicting_evidence";
  description: string;
  severity: "critical" | "important" | "optional";
  resolution: "reuse_existing" | "targeted_discovery" | "ask_root_agent" | "ask_user" | "document_assumption";
  /** Optional follow-up for targeted discovery. */
  contextRequest?: ContextRequest;
}

export interface GapAnalysis {
  gaps: ContextGap[];
  /** True when at least one gap must be resolved with the user before compiling. */
  requiresClarification: boolean;
  /** True when targeted discovery should run before compiling. */
  requiresDiscovery: boolean;
  /** True when existing skills already cover the task. */
  reuseExisting: boolean;
}

// ---------------------------------------------------------------------------
// §6 Clarification, assumptions, SLA
// ---------------------------------------------------------------------------

export const MAXIMUM_CLARIFICATION_ROUNDS = 3 as const;

export interface ClarificationQuestion {
  id: string;
  question: string;
  reason: string;
  required: boolean;
  options?: string[];
}

export interface ClarificationRequest {
  runId: string;
  round: number;
  /** Configured round limit (≤ MAXIMUM_CLARIFICATION_ROUNDS). */
  maximumRounds: number;
  questions: ClarificationQuestion[];
  context: string;
}

export interface ClarificationAnswer {
  questionId: string;
  answer?: string;
  status: "answered" | "declined" | "skipped";
}

export interface ClarificationResponse {
  runId: string;
  round: number;
  answers: ClarificationAnswer[];
}

export interface Assumption {
  id: string;
  questionId: string;
  statement: string;
  basis: string;
  impact: "low" | "medium" | "high";
  status: "declined" | "skipped" | "round_limit_reached";
}

export const DEFAULT_ACTIVE_BUDGET_MS = 120_000 as const;
/** Below this much remaining budget, the deterministic compile is the right fallback (ADR-018). */
export const DETERMINISTIC_COMPILE_THRESHOLD_MS = 20_000 as const;

/** Serializable budget state, persisted with the run so pauses survive process boundaries. */
export interface BudgetSnapshot {
  maximumMs: number;
  consumedMs: number;
  /** Monotonic timestamp (ms) of the current active segment start; undefined when not running. */
  activeSince?: number;
  /** Wall-clock ms (Date.now) of the same instant — fallback only when clockEpoch no longer matches (reboot). */
  activeSinceWallMs?: number;
  /** Monotonic timestamp (ms) when the human pause began. */
  pausedAt?: number;
  pauseReason?: "human_clarification";
  roundsUsed: number;
  maximumRounds: number;
  /** Boot identifier used to detect that monotonic timestamps are comparable. */
  clockEpoch: string;
}

/** §6.4 */
export interface SLAController {
  start(): void;
  pause(reason: "human_clarification"): void;
  resume(): void;
  remainingMs(): number;
  consume(ms: number): void;
  isExpired(): boolean;
  isPaused(): boolean;
  consumedMs(): number;
  snapshot(): BudgetSnapshot;
}

// ---------------------------------------------------------------------------
// §7 Expertise compiler
// ---------------------------------------------------------------------------

export interface SkillInventoryItem {
  name: string;
  description: string;
  /** Path to the skill directory (or SKILL.md). */
  path: string;
  scope: "project" | "personal" | "plugin" | "ephemeral" | "unknown";
  harness?: HarnessId;
}

export interface CompilationPolicy {
  targetTokenCount: number;
  maximumTokenCount: number;
  requireEvidence: boolean;
  portability: "agent-skills";
}

export interface SkillCompilationRequest {
  runId: string;
  task: TaskIntent;
  context: ContextAnalysisResult;
  gaps: ContextGap[];
  assumptions: Assumption[];
  existingSkills: SkillInventoryItem[];
  compilationPolicy: CompilationPolicy;
}

/** A project-specific constraint and the evidence ids/paths that ground it. */
export interface GroundedStatement {
  statement: string;
  /** Packet evidence ids ("ev_…"), repository-relative paths, or assumption ids ("asm_…"). */
  evidence: string[];
}

/**
 * Structured skill content produced by the host LLM (or the deterministic fallback compiler).
 * The core renders it into a canonical Agent Skills artifact.
 */
export interface SkillDraft {
  schemaVersion: SchemaVersion;
  runId: string;
  /** lowercase kebab-case, ≤ 64 chars. */
  name: string;
  /** What the skill does and when to use it (≤ 1024 chars). */
  description: string;
  specialist: { identity: string; responsibility: string };
  /** §7.3 authority model. */
  authority: {
    ownership: string[];
    decisionRights: string[];
    boundaries: string[];
    accountability: string[];
  };
  /** Ordered methodology / workflow steps. */
  workflow: string[];
  projectConstraints: GroundedStatement[];
  verification: string[];
  /** Assumption ids carried into the skill. */
  assumptions?: string[];
  /** Optional supporting references rendered under references/. */
  references?: Array<{ fileName: string; title: string; content: string }>;
}

export interface SkillFile {
  /** POSIX path relative to the skill directory, e.g. "SKILL.md", "references/project-conventions.md". */
  path: string;
  content: string;
}

export interface SkillProvenance {
  runId: string;
  repositoryId: string;
  generatorVersion: string;
  skillVersion: string;
  contextFingerprint: string;
  evidenceIds: string[];
  assumptionIds: string[];
  createdAt: string;
}

export interface GeneratedSkill {
  /** `${name}@${artifactHash.slice(0, 12)}` */
  skillId: string;
  name: string;
  description: string;
  files: SkillFile[];
  /** sha256 over sorted (path, content) pairs — see core/hash.ts hashSkillFiles. */
  artifactHash: string;
  /** Estimated tokens of SKILL.md. */
  tokenCount: number;
  provenance: SkillProvenance;
}

// ---------------------------------------------------------------------------
// §8 Evaluation
// ---------------------------------------------------------------------------

export type EvalStatus = "pass" | "warning" | "fail";

export interface EvalFinding {
  code: string;
  message: string;
  severity: "error" | "warning" | "info";
  path?: string;
}

export interface EvalResult {
  checkId: string;
  status: EvalStatus;
  /** A failing mandatory check blocks activation; it is never downgraded to a warning (§8.1). */
  mandatory: boolean;
  findings: EvalFinding[];
  durationMs: number;
}

export interface BehaviouralEvalCase {
  id: string;
  task: string;
  expectedActions: string[];
  prohibitedActions: string[];
  expectedOutcome: string;
  deterministicAssertions?: string[];
}

export interface BehaviouralEvalResult {
  caseId: string;
  status: EvalStatus;
  executed: boolean;
  mode: "static" | "host_simulation";
  coveredExpected: string[];
  missingExpected: string[];
  prohibitedViolations: string[];
  findings: EvalFinding[];
  durationMs: number;
}

/**
 * §8.3 skill-versus-no-skill comparison. The baseline is what the host already has without the
 * skill: the repository's own instructions. Lift is the skill's extra coverage of the eval case.
 */
export interface BaselineComparison {
  caseId: string;
  mode: "static" | "host_simulation";
  /** Share (0..1) of expected actions covered with the skill. */
  skillCoverage: number;
  /** Share (0..1) of expected actions covered by the baseline alone. */
  baselineCoverage: number;
  /** skillCoverage − baselineCoverage. */
  lift: number;
  /** Prohibited actions the baseline would allow that the skill rules out. */
  prohibitionsAdded: number;
  verdict: "improves" | "no_improvement" | "regresses";
  /** Why the comparison ran: promotion, revision, regression or compiler change (§8.3). */
  trigger: "promotion" | "revision" | "regression" | "always";
  at: string;
}

export interface SkillEvaluationReport {
  runId: string;
  skillId: string;
  artifactHash: string;
  status: EvalStatus;
  generation: {
    structural: EvalResult;
    grounding: EvalResult;
    scope: EvalResult;
    duplication: EvalResult;
    conciseness: EvalResult;
    portability: EvalResult;
    security: EvalResult;
  };
  behavioural: {
    executed: boolean;
    status: EvalStatus;
    caseId?: string;
    result?: BehaviouralEvalResult;
  };
  assumptions: Assumption[];
  tokenCount: number;
  durationMs: number;
  generatedAt: string;
  /** Findings that a revision should address (errors first). */
  revisionHints: string[];
}

// ---------------------------------------------------------------------------
// §9 Activation
// ---------------------------------------------------------------------------

export type ActivationCapability =
  | "live_skill_registration"
  | "watched_directory"
  | "current_turn_instruction_injection"
  | "explicit_reload";

export interface ActivationResult {
  success: boolean;
  capability: ActivationCapability;
  skillId: string;
  artifactHash: string;
  /** Where the skill was installed for the session, if on disk. */
  installedPath?: string;
  /** Full SKILL.md content, returned for current-turn injection so the root agent provably receives it. */
  instructions?: string;
  /** True when the host must run an explicit reload (e.g. Claude Code /reload-skills). */
  requiresReload?: boolean;
  /** How the root agent should invoke/apply the skill. */
  invocationHint?: string;
  message?: string;
}

export interface ActivationAdapter {
  getCapabilities(): Promise<ActivationCapability[]>;
  activate(skill: GeneratedSkill): Promise<ActivationResult>;
  deactivate(skillId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// §10 Storage & lifecycle
// ---------------------------------------------------------------------------

export type StorageScope = "ephemeral" | "project" | "personal";

export type LifecycleStatus = "ephemeral" | "active" | "persisted" | "expired" | "invalidated" | "discarded";

export interface SkillInstall {
  harness: HarnessId;
  scope: StorageScope;
  /** Absolute path of the installed skill directory. */
  path: string;
  artifactHash: string;
  installedAt: string;
}

/** §10.5 canonical bundle metadata, stored next to the canonical copy. */
export interface CanonicalBundleRecord {
  skillId: string;
  name: string;
  artifactHash: string;
  skillVersion: string;
  generatorVersion: string;
  repositoryId: string;
  contextFingerprint: ContextFingerprint;
  evaluation: SkillEvaluationReport;
  createdAt: string;
  updatedAt: string;
  lifecycleStatus: LifecycleStatus;
  installs: SkillInstall[];
  /** Repository-relative files the skill depends on (used for freshness). */
  dependsOn: string[];
  /** Task description the skill was generated for. */
  task: string;
  /** §8.3 baseline comparison recorded when the skill was promoted or revised. */
  baseline?: BaselineComparison;
  /** Previous versions this bundle replaced (newest first). */
  history?: Array<{ skillVersion: string; artifactHash: string; replacedAt: string; reason: string }>;
}

export interface ContextFingerprint {
  repositoryId: string;
  /** sha256 over sorted component hashes. */
  overall: string;
  /** Component key → content hash, e.g. "file:package.json" → "ab12…", "fact:framework:react" → "18.3.1". */
  components: Record<string, string>;
}

export interface FreshnessDecision {
  decision: "reuse" | "augment" | "regenerate";
  reasons: string[];
  changedComponents: string[];
}

export type PersistenceChoice = "project" | "personal" | "ephemeral" | "discard";

// ---------------------------------------------------------------------------
// §11 Harness adapters
// ---------------------------------------------------------------------------

export interface HostCapabilities {
  harness: HarnessId;
  activation: ActivationCapability[];
  nativeExplicitInvocation: boolean;
  nativeAutomaticSkillSelection: boolean;
  nativeUserInteraction: boolean;
  pluginIntegration: boolean;
  /** Absolute paths of skill directories this harness discovers. */
  projectSkillsDir: string;
  personalSkillsDir: string;
  /** Whether the harness CLI was found on PATH (best effort). */
  installed: boolean;
}

export interface WorkspaceContext {
  root: string;
  workingDirectory: string;
  repositoryId: string;
  revision?: string;
  sessionId: string;
}

export interface HarnessAdapter {
  readonly id: HarnessId;
  initialize(): Promise<void>;
  getCapabilities(): Promise<HostCapabilities>;
  getWorkspaceContext(): Promise<WorkspaceContext>;
  getExistingSkills(): Promise<SkillInventoryItem[]>;
  /**
   * Native user interaction. CLI-bridged adapters cannot ask directly: they return the request
   * to the root agent, which asks through its native tool and submits the response later.
   */
  askUser(request: ClarificationRequest): Promise<ClarificationResponse>;
  loadSkillForSession(skill: GeneratedSkill): Promise<ActivationResult>;
  saveSkill(skill: GeneratedSkill, scope: "project" | "personal"): Promise<void>;
  removeSkill(skillId: string, scope: StorageScope): Promise<void>;
}

// ---------------------------------------------------------------------------
// §17 Errors
// ---------------------------------------------------------------------------

export type ErrorCategory =
  | "discovery"
  | "schema"
  | "analysis_timeout"
  | "clarification"
  | "compilation"
  | "evaluation"
  | "activation"
  | "sla_expired"
  | "persistence"
  | "repository_changed"
  | "security"
  | "configuration"
  | "invalid_state"
  | "internal";

export type ComponentId =
  | "orchestrator"
  | "discovery"
  | "context-packet"
  | "context-analyzer"
  | "evidence-registry"
  | "context-gap-analyzer"
  | "clarification-manager"
  | "sla"
  | "skill-compiler"
  | "eval-engine"
  | "activation"
  | "storage"
  | "lifecycle"
  | "adapter"
  | "cli"
  | "core";

export interface ErrorInfo {
  runId?: string;
  category: ErrorCategory;
  component: ComponentId;
  message: string;
  elapsedActiveMs?: number;
  recoverable: boolean;
  fallbackAction: string;
}

// ---------------------------------------------------------------------------
// §19 Configuration
// ---------------------------------------------------------------------------

export interface DynamicSkillsConfig {
  version: "1.0";
  mode: "auto" | "explicit" | "off";
  execution: {
    activeBudgetMs: number;
    maximumClarificationRounds: number;
    maximumRevisionAttempts: number;
  };
  discovery: {
    mode: "hybrid" | "programmatic";
    parallel: boolean;
    contextTokenBudget: number;
    maximumFiles: number;
    maximumFileBytes: number;
    maximumTotalBytes: number;
    providerTimeoutMs: number;
    concurrency: number;
  };
  generation: {
    targetSkillTokens: number;
    maximumSkillTokens: number;
    format: "agent-skills";
  };
  evaluation: {
    generationChecks: "required";
    behaviouralSmokeEval: "required" | "optional";
    baselineComparison: "promotion-only" | "always" | "never";
  };
  lifecycle: {
    defaultScope: "ephemeral";
    requireApprovalForPersistence: boolean;
    /** Ephemeral run retention before `clean` removes it. */
    ephemeralRetentionHours: number;
  };
}

export const DEFAULT_CONFIG: DynamicSkillsConfig = {
  version: "1.0",
  mode: "auto",
  execution: {
    activeBudgetMs: DEFAULT_ACTIVE_BUDGET_MS,
    maximumClarificationRounds: MAXIMUM_CLARIFICATION_ROUNDS,
    maximumRevisionAttempts: 1,
  },
  discovery: {
    mode: "hybrid",
    parallel: true,
    contextTokenBudget: 12_000,
    maximumFiles: 30,
    maximumFileBytes: 64 * 1024,
    maximumTotalBytes: 512 * 1024,
    providerTimeoutMs: 4_000,
    concurrency: 6,
  },
  generation: {
    targetSkillTokens: 2_000,
    maximumSkillTokens: 5_000,
    format: "agent-skills",
  },
  evaluation: {
    generationChecks: "required",
    behaviouralSmokeEval: "required",
    baselineComparison: "promotion-only",
  },
  lifecycle: {
    defaultScope: "ephemeral",
    requireApprovalForPersistence: true,
    ephemeralRetentionHours: 24,
  },
};

/** §15.1 initial per-stage budget envelopes (ms). Stages may overlap; the total is the hard limit. */
export const STAGE_BUDGET_MS = {
  routing: 3_000,
  discovery: 12_000,
  analysis: 15_000,
  compilation: 15_000,
  evaluation: 10_000,
  activation: 5_000,
} as const;
