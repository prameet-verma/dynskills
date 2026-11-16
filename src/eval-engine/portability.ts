import type { EvalFinding, EvalResult, GeneratedSkill } from "../contracts/index.js";
import type { EvalContext } from "./context.js";
import { SKILL_FILE, error, parsedSkill, runCheck, warning } from "./context.js";

/** Frontmatter keys that only one harness understands; a portable skill must not depend on them. */
export const HARNESS_SPECIFIC_FRONTMATTER: readonly string[] = [
  "disable-model-invocation",
  "user-invocable",
  "argument-hint",
  "model",
  "context",
  "agent",
  "hooks",
  "when_to_use",
  "mode",
  "tools",
];

/** Absolute, machine-specific paths. */
const ABSOLUTE_PATH_PATTERNS: ReadonlyArray<{ re: RegExp; label: string }> = [
  { re: /(^|[\s`'"(=:])\/Users\/[^\s/`'")]+/m, label: "/Users/…" },
  { re: /(^|[\s`'"(=:])\/home\/[^\s/`'")]+/m, label: "/home/…" },
  { re: /(^|[\s`'"(=:])\/root\//m, label: "/root/…" },
  { re: /(^|[^A-Za-z0-9])[A-Za-z]:\\[^\s]/m, label: "C:\\…" },
];

/** Harness-specific tool names and directories (warning: they should not be required by a portable skill). */
const HARNESS_SPECIFIC_CONTENT: ReadonlyArray<{ re: RegExp; label: string }> = [
  { re: /(^|[^\w.-])\.claude\//m, label: ".claude/" },
  { re: /(^|[^\w.-])\.codex\//m, label: ".codex/" },
  { re: /(^|[^\w.-])\.opencode\//m, label: ".opencode/" },
  { re: /\bAskUserQuestion\b/, label: "AskUserQuestion" },
  { re: /\bTodoWrite\b/, label: "TodoWrite" },
  { re: /\bExitPlanMode\b/, label: "ExitPlanMode" },
  { re: /\bapply_patch\b/, label: "apply_patch" },
  { re: /\$ARGUMENTS\b/, label: "$ARGUMENTS" },
  { re: /\/reload-skills\b/, label: "/reload-skills" },
];

function portabilityFindings(skill: GeneratedSkill): EvalFinding[] {
  const f: EvalFinding[] = [];
  const fm = parsedSkill(skill)?.frontmatter;
  if (fm) {
    for (const key of HARNESS_SPECIFIC_FRONTMATTER) {
      if (key in fm) f.push(error("harness_specific_frontmatter", `Frontmatter key "${key}" is harness-specific; a portable skill must not require it.`, SKILL_FILE));
    }
    if ("allowed-tools" in fm) {
      f.push(warning("allowed_tools_experimental", "`allowed-tools` is experimental and harness-dependent; avoid relying on it.", SKILL_FILE));
    }
  }
  for (const file of skill.files) {
    for (const { re, label } of ABSOLUTE_PATH_PATTERNS) {
      if (re.test(file.content)) {
        f.push(error("absolute_path", `${file.path} contains a machine-specific absolute path (${label}); use repository-relative paths.`, file.path));
      }
    }
    const harness = HARNESS_SPECIFIC_CONTENT.filter(({ re }) => re.test(file.content)).map(({ label }) => label);
    if (harness.length > 0) {
      f.push(warning("harness_specific_content", `${file.path} references harness-specific tools or directories (${harness.join(", ")}); keep instructions harness-neutral.`, file.path));
    }
  }
  return f;
}

/** Mandatory: no harness-specific required frontmatter and no absolute machine paths. */
export function checkPortability(skill: GeneratedSkill, _ctx: EvalContext): EvalResult {
  return runCheck("portability", true, () => portabilityFindings(skill));
}
