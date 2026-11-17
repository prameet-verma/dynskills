import path from "node:path";
import { DEFAULT_ACTIVE_BUDGET_MS, DEFAULT_CONFIG, type DynamicSkillsConfig } from "../contracts/index.js";
import { dsError, readJsonIfExists } from "../core/index.js";

export const CONFIG_FILE = "dynamic-skills.config.json";

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function merge<T>(base: T, patch: unknown, at: string): T {
  if (patch === undefined) return base;
  if (!isObject(base)) {
    if (typeof patch !== typeof base) {
      throw dsError("configuration", "orchestrator", `${CONFIG_FILE}: "${at}" must be a ${typeof base}`, {
        recoverable: true,
        fallbackAction: `Fix or delete ${CONFIG_FILE}; defaults work without configuration.`,
      });
    }
    return patch as T;
  }
  if (!isObject(patch)) {
    throw dsError("configuration", "orchestrator", `${CONFIG_FILE}: "${at || "root"}" must be an object`, { recoverable: true });
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in out)) {
      throw dsError("configuration", "orchestrator", `${CONFIG_FILE}: unknown setting "${at ? `${at}.` : ""}${k}"`, { recoverable: true });
    }
    out[k] = merge(out[k], v, at ? `${at}.${k}` : k);
  }
  return out as T;
}

/** §19: defaults work without a config file; a config file may override any subset. */
export function resolveConfig(patch?: DeepPartial<DynamicSkillsConfig>): DynamicSkillsConfig {
  const cfg = merge(DEFAULT_CONFIG, patch ?? {}, "");
  if (cfg.execution.activeBudgetMs <= 0 || cfg.execution.activeBudgetMs > DEFAULT_ACTIVE_BUDGET_MS) {
    throw dsError("configuration", "orchestrator", `execution.activeBudgetMs must be in (0, ${DEFAULT_ACTIVE_BUDGET_MS}]: the ${DEFAULT_ACTIVE_BUDGET_MS / 1000}-second budget is a hard limit`, {
      recoverable: true,
    });
  }
  if (cfg.execution.maximumClarificationRounds < 0 || cfg.execution.maximumClarificationRounds > 3) {
    throw dsError("configuration", "orchestrator", "execution.maximumClarificationRounds must be between 0 and 3", { recoverable: true });
  }
  if (cfg.generation.targetSkillTokens > cfg.generation.maximumSkillTokens) {
    throw dsError("configuration", "orchestrator", "generation.targetSkillTokens cannot exceed maximumSkillTokens", { recoverable: true });
  }
  const enums: Array<[string, unknown, readonly string[]]> = [
    ["mode", cfg.mode, ["auto", "explicit", "off"]],
    ["discovery.mode", cfg.discovery.mode, ["hybrid", "programmatic"]],
    ["generation.format", cfg.generation.format, ["agent-skills"]],
    ["evaluation.generationChecks", cfg.evaluation.generationChecks, ["required"]],
    ["evaluation.behaviouralSmokeEval", cfg.evaluation.behaviouralSmokeEval, ["required", "optional"]],
    ["evaluation.baselineComparison", cfg.evaluation.baselineComparison, ["promotion-only", "always", "never"]],
    ["lifecycle.defaultScope", cfg.lifecycle.defaultScope, ["ephemeral"]],
  ];
  for (const [key, value, allowed] of enums) {
    if (!allowed.includes(value as string)) {
      throw dsError("configuration", "orchestrator", `${CONFIG_FILE}: "${key}" must be one of ${allowed.map((a) => `"${a}"`).join(", ")}`, { recoverable: true });
    }
  }
  if (!cfg.lifecycle.requireApprovalForPersistence) {
    throw dsError("configuration", "orchestrator", "lifecycle.requireApprovalForPersistence cannot be disabled (§10.4)", { recoverable: true });
  }
  return cfg;
}

export async function loadConfig(root: string): Promise<DynamicSkillsConfig> {
  const raw = await readJsonIfExists<DeepPartial<DynamicSkillsConfig>>(path.join(root, CONFIG_FILE));
  return resolveConfig(raw);
}
