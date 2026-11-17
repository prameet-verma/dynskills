import type { EvalFinding } from "../contracts/index.js";
import { SKILL_FILE, error } from "./context.js";

/** Package-manager subcommands that are not project scripts. */
const BUILTINS: Record<string, ReadonlySet<string>> = {
  npm: new Set(["install", "i", "ci", "add", "uninstall", "remove", "rm", "exec", "x", "ls", "list", "audit", "pack", "publish", "init", "link", "outdated", "update", "version", "view", "config", "cache", "help", "explain", "why", "dedupe", "prune", "rebuild", "fund", "doctor", "query", "pkg"]),
  pnpm: new Set(["install", "i", "add", "remove", "rm", "uninstall", "up", "update", "exec", "dlx", "x", "why", "ls", "list", "audit", "pack", "publish", "init", "link", "unlink", "outdated", "store", "env", "setup", "config", "create", "dedupe", "patch", "patch-commit", "import", "prune", "rebuild", "fetch", "deploy", "licenses", "self-update"]),
  yarn: new Set(["install", "add", "remove", "up", "upgrade", "dlx", "exec", "why", "info", "list", "audit", "pack", "publish", "init", "link", "unlink", "outdated", "config", "create", "dedupe", "workspace", "workspaces", "set", "cache", "node", "bin", "constraints", "patch", "plugin", "version"]),
  bun: new Set(["install", "i", "add", "a", "remove", "rm", "update", "x", "pm", "link", "unlink", "init", "create", "build", "upgrade", "outdated", "publish", "audit", "exec"]),
};

/** npm runs these lifecycle names as scripts without `run`. */
const NPM_SCRIPT_ALIASES = new Set(["test", "t", "tst", "start", "stop", "restart"]);

const INVOCATION = /(?<![\w./-])(npm|pnpm|yarn|bun)\s+(?:(run|run-script|rum|urn)\s+)?([A-Za-z0-9][\w:.-]*)/g;

/** The script each package-manager invocation in `text` would run, or undefined for built-ins. */
export function referencedScripts(text: string): Array<{ invocation: string; script: string }> {
  const out: Array<{ invocation: string; script: string }> = [];
  for (const m of text.matchAll(INVOCATION)) {
    const [raw, pm, run, rawName] = m as unknown as [string, string, string | undefined, string];
    // Sentence punctuation isn't part of a script name ("Run npm run lint.").
    const name = rawName.replace(/[.:]+$/, "");
    const invocation = raw.slice(0, raw.length - (rawName.length - name.length));
    let script: string | undefined;
    if (run !== undefined) script = name;
    else if (pm === "npm") script = NPM_SCRIPT_ALIASES.has(name) ? (name === "t" || name === "tst" ? "test" : name) : undefined;
    else if (pm === "bun" && name === "test") script = undefined; // `bun test` is Bun's own runner
    else script = BUILTINS[pm]?.has(name) ? undefined : name;
    if (script !== undefined) out.push({ invocation: invocation.trim(), script });
  }
  return out;
}

/**
 * Commands a skill tells the agent to run must exist: `npm test` fails when package.json has no
 * "test" script. `scripts` is the root package.json's scripts; undefined skips the check (no
 * package.json, or not a JavaScript project).
 */
export function unknownScriptFindings(body: string, scripts: Readonly<Record<string, string>> | undefined): EvalFinding[] {
  if (scripts === undefined) return [];
  const seen = new Set<string>();
  const findings: EvalFinding[] = [];
  for (const { invocation, script } of referencedScripts(body)) {
    if (scripts[script] !== undefined || seen.has(invocation)) continue;
    seen.add(invocation);
    const available = Object.keys(scripts);
    findings.push(
      error(
        "unknown_script",
        `\`${invocation}\` runs the "${script}" script, but package.json has no such script, so the command fails. ` +
          (available.length > 0 ? `Available scripts: ${available.join(", ")}.` : "package.json defines no scripts.") +
          " Use a command the project actually has, such as one from the discovered test configuration.",
        SKILL_FILE,
      ),
    );
  }
  return findings;
}
