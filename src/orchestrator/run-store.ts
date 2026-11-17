import { readdir, rm, open, stat, mkdir } from "node:fs/promises";
import path from "node:path";
import type {
  ActivationResult,
  Assumption,
  BaselineComparison,
  BudgetSnapshot,
  ClarificationRequest,
  DynamicSkillsConfig,
  ErrorInfo,
  GapAnalysis,
  GenerationState,
  HarnessId,
  PersistenceChoice,
  RunIdentity,
  SkillEvaluationReport,
  SkillInventoryItem,
  TaskIntent,
} from "../contracts/index.js";
import { dsError, isoNow, readJsonIfExists, writeJson, sha256, stableStringify } from "../core/index.js";
import type { ClarificationState } from "../clarification-manager/index.js";
import { runDir, runtimeRoot, ensureRuntimeRoot } from "../storage/index.js";
import { assertTransition } from "./state-machine.js";

/** §18.7 per-run performance metrics. */
export interface RunMetrics {
  discoveryMs?: number;
  packetTokens?: number;
  packetFiles?: number;
  hostSubmissions: number;
  targetedDiscoveryRounds: number;
  compilationMs?: number;
  evaluationMs?: number;
  activationMs?: number;
  /** Active processing consumed when the run reached a terminal/active state. */
  activeMs?: number;
  timedOut: boolean;
}

export interface RunRecord {
  schemaVersion: "1.0";
  identity: RunIdentity;
  root: string;
  harness: HarnessId;
  state: GenerationState;
  history: Array<{ from: GenerationState; to: GenerationState; at: string; note?: string }>;
  /** Task as submitted, with clarified answers appended to constraints. */
  task: TaskIntent;
  config: DynamicSkillsConfig;
  budget: BudgetSnapshot;
  forceGenerate: boolean;
  existingSkills: SkillInventoryItem[];
  analysisAttempts: number;
  compileAttempts: number;
  gaps?: GapAnalysis;
  clarification?: ClarificationState;
  pendingClarification?: ClarificationRequest;
  assumptions: Assumption[];
  skill?: { name: string; skillId: string; artifactHash: string; stagedDir: string; tokenCount: number };
  evaluation?: Pick<SkillEvaluationReport, "status" | "artifactHash" | "tokenCount" | "revisionHints">;
  activation?: Omit<ActivationResult, "instructions">;
  persistence?: { choice: PersistenceChoice; path?: string };
  reusedSkills?: SkillInventoryItem[];
  /** §17: content hashes of every file in the packet at discovery time, re-checked before activation. */
  discoveryFingerprint?: Record<string, string>;
  /** §10.6: set when this run revises a stale persisted skill instead of creating a new one. */
  revisionOf?: {
    name: string;
    scope: "project" | "personal";
    previousVersion: string;
    nextVersion: string;
    previousArtifactHash: string;
    decision: "augment" | "regenerate";
    reasons: string[];
    changedComponents: string[];
  };
  /** Version the generated skill is rendered with. */
  skillVersion?: string;
  /** §8.3 baseline comparison, when one ran. */
  baseline?: BaselineComparison;
  /** Files that changed after discovery but are not cited by the skill (reported, not fatal). */
  uncitedChanges?: string[];
  error?: ErrorInfo;
  metrics: RunMetrics;
  /** §4.3 idempotency: the last accepted request and its response. */
  lastRequest?: { command: string; inputHash: string; stateBefore: GenerationState; response: unknown };
  createdAt: string;
  updatedAt: string;
}

/** Files kept next to run.json. */
export const RUN_FILES = {
  record: "run.json",
  packet: "context-packet.json",
  registry: "evidence-registry.json",
  analysis: "context-analysis.json",
  compilationRequest: "compilation-request.json",
  compilePrompt: "compile-prompt.md",
  draft: "skill-draft.json",
  evaluation: "evaluation-report.json",
  evalCase: "behavioural-eval-case.json",
  clarificationRequest: "clarification-request.json",
  lock: ".lock",
} as const;

export function requestHash(command: string, input: unknown): string {
  return sha256(`${command}\n${stableStringify(input ?? null)}`);
}

export class RunStore {
  constructor(readonly projectRoot: string) {}

  dirFor(record: Pick<RunRecord, "identity">): string {
    return runDir(this.projectRoot, record.identity.sessionId, record.identity.runId);
  }

  fileFor(record: Pick<RunRecord, "identity">, file: keyof typeof RUN_FILES): string {
    return path.join(this.dirFor(record), RUN_FILES[file]);
  }

  async create(record: RunRecord): Promise<void> {
    await ensureRuntimeRoot(this.projectRoot);
    await mkdir(this.dirFor(record), { recursive: true });
    await this.save(record);
  }

  async save(record: RunRecord): Promise<void> {
    record.updatedAt = isoNow();
    await writeJson(this.fileFor(record, "record"), record);
  }

  /** Locate a run by id across sessions. */
  async load(runId: string): Promise<RunRecord> {
    if (!/^run_[a-z0-9]+$/.test(runId)) {
      throw dsError("invalid_state", "orchestrator", `Malformed runId: ${runId}`, { recoverable: true, fallbackAction: "Use the runId printed by `run start`." });
    }
    const sessions = path.join(runtimeRoot(this.projectRoot), "sessions");
    const entries = await readdir(sessions).catch(() => [] as string[]);
    for (const s of entries) {
      const rec = await readJsonIfExists<RunRecord>(path.join(sessions, s, "runs", runId, RUN_FILES.record));
      if (rec) return rec;
    }
    throw dsError("invalid_state", "orchestrator", `Unknown run: ${runId}`, {
      runId,
      recoverable: true,
      fallbackAction: "Start a new run with `dynskills run start`.",
    });
  }

  async list(): Promise<RunRecord[]> {
    const sessions = path.join(runtimeRoot(this.projectRoot), "sessions");
    const out: RunRecord[] = [];
    for (const s of await readdir(sessions).catch(() => [] as string[])) {
      for (const r of await readdir(path.join(sessions, s, "runs")).catch(() => [] as string[])) {
        const rec = await readJsonIfExists<RunRecord>(path.join(sessions, s, "runs", r, RUN_FILES.record));
        if (rec) out.push(rec);
      }
    }
    return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async remove(record: RunRecord): Promise<void> {
    await rm(this.dirFor(record), { recursive: true, force: true });
  }

  /**
   * Exclusive per-run lock so two concurrent bridge commands cannot interleave state changes.
   * Stale locks (older than 2 minutes) are broken.
   */
  async withLock<T>(record: Pick<RunRecord, "identity">, fn: () => Promise<T>): Promise<T> {
    const lockPath = this.fileFor(record, "lock");
    let handle;
    try {
      handle = await open(lockPath, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const st = await stat(lockPath).catch(() => undefined);
      if (st && Date.now() - st.mtimeMs > 120_000) {
        await rm(lockPath, { force: true });
        handle = await open(lockPath, "wx");
      } else {
        throw dsError("invalid_state", "orchestrator", "Another command is already operating on this run", {
          runId: record.identity.runId,
          recoverable: true,
          fallbackAction: "Wait for the other command to finish, then retry.",
        });
      }
    }
    try {
      return await fn();
    } finally {
      await handle.close();
      await rm(lockPath, { force: true });
    }
  }
}

export function transition(record: RunRecord, to: GenerationState, note?: string): void {
  assertTransition(record.state, to, record.identity.runId);
  record.history.push({ from: record.state, to, at: isoNow(), ...(note ? { note } : {}) });
  record.state = to;
}
