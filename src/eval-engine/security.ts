import type { EvalFinding, EvalResult, GeneratedSkill } from "../contracts/index.js";
import { redactSecrets } from "../core/index.js";
import { annotateLines, isBoundaryLine, isProhibition, parseSkillMarkdown } from "../skill-compiler/index.js";
import type { AnnotatedLine } from "../skill-compiler/index.js";
import type { EvalContext } from "./context.js";
import { SKILL_FILE, error, runCheck, warning } from "./context.js";

/** Executable artifacts are disabled in the initial release (§16.2: instruction-only skills). */
const EXECUTABLE_EXTENSIONS = /\.(sh|bash|zsh|fish|ps1|psm1|bat|cmd|exe|dll|so|dylib|bin|py|rb|pl|php|js|mjs|cjs|ts|mts|cts|jar|app|command|vbs)$/i;

/** Dangerous instruction patterns (§16.1 unsafe instructions). */
export const DANGEROUS_INSTRUCTIONS: ReadonlyArray<{ code: string; label: string; re: RegExp }> = [
  { code: "pipe_to_shell", label: "piping a download into a shell", re: /\b(curl|wget|iwr|invoke-webrequest)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|da|fi)?sh\b|\b(iex|invoke-expression)\b/i },
  { code: "destructive_delete", label: "recursive deletion of root/home", re: /\brm\s+(-[a-z]*\s+)*-[a-z]*(r[a-z]*f|f[a-z]*r)[a-z]*\s+(--no-preserve-root\s+)?(\/|~|\$HOME|\/\*)(\s|$|["'`;])/i },
  {
    code: "disable_safety",
    label: "disabling permission or sandbox controls",
    re: /--dangerously-skip-permissions|dangerouslyDisableSandbox|--no-sandbox|--yolo\b|bypassPermissions|\b(disable|bypass|skip|turn off|circumvent|override)\b[^\n]{0,30}\b(permission|permissions|sandbox|approval|approvals|safety|guardrails?)\b/i,
  },
  {
    code: "read_secrets",
    label: "reading or printing secrets or credentials",
    re: /\b(cat|print|printenv|echo|read|output|display|dump|show|type|less|more|head|tail|log|copy|upload|send)\b[^\n]{0,40}(\.env\b|credentials|id_rsa|id_ed25519|\.ssh\/|\.aws\/|\.npmrc|\.netrc|private key)/i,
  },
  {
    code: "prompt_injection",
    label: "overriding previous or system instructions",
    re: /\b(ignore|disregard|override|forget)\b[^\n]{0,30}\b(previous|prior|above|system|all|earlier|root agent'?s?)\b[^\n]{0,20}\b(instructions?|prompts?|rules|guidelines)\b/i,
  },
  {
    code: "exfiltration",
    label: "sending data to external URLs",
    re: /\b(send|upload|post|exfiltrate|transmit|forward|leak|beacon)\b[^\n]{0,60}(https?:\/\/|webhook)|\bcurl\b[^\n]*(\s-d\b|--data|\s-F\b|--form|\s-T\b|--upload-file)[^\n]*https?:\/\//i,
  },
  {
    code: "modify_global_instructions",
    label: "modifying global agent instructions or settings",
    re: /(~|\$HOME)\/\.(claude|codex|config\/opencode)\b|\b(modify|edit|update|overwrite|write to|append to|change)\b[^\n]{0,30}\b(global|user-level|personal)\s+(agent\s+)?(instructions|claude\.md|agents\.md|settings|config)/i,
  },
  {
    code: "install_mcp",
    label: "installing MCP servers",
    re: /\b(install|add|register|configure|enable)\b[^\n]{0,30}\bmcp\b|\bmcp add\b|\bmcpServers\b/i,
  },
  { code: "permission_change", label: "world-writable permission changes", re: /\bchmod\s+(-R\s+)?(0?777|a\+rwx)\b/i },
];

function hasTraversal(p: string): boolean {
  return p.includes("\0") || p.includes("\\") || p.startsWith("/") || /^[A-Za-z]:/.test(p) || p.split("/").some((s) => s === ".." || s === "." || s === "");
}

function securityFindings(skill: GeneratedSkill): EvalFinding[] {
  const f: EvalFinding[] = [];
  for (const file of skill.files) {
    const p = file.path;
    if (hasTraversal(p)) f.push(error("path_traversal", `File path "${p}" is not a normalised relative path inside the skill directory.`, p));
    if (p === "scripts" || p.startsWith("scripts/")) {
      f.push(error("scripts_not_allowed", `"${p}": generated skills are instruction-only; scripts/ is not allowed.`, p));
    } else if (EXECUTABLE_EXTENSIONS.test(p)) {
      f.push(error("executable_artifact", `"${p}" is an executable artifact; generated skills are instruction-only.`, p));
    } else if (/^#!/.test(file.content)) {
      f.push(error("executable_artifact", `"${p}" starts with a shebang; generated skills are instruction-only.`, p));
    }
    const redacted = redactSecrets(file.content);
    if (redacted.redactions > 0) {
      f.push(error("secret_detected", `${p} contains ${redacted.redactions} likely secret(s); remove them from the skill.`, p));
    }

    // Dangerous instructions. In SKILL.md, prohibitions under "### Boundaries" are allowed;
    // prohibitions elsewhere are a warning; affirmative instructions fail.
    const isSkillMd = p === SKILL_FILE;
    const lines: AnnotatedLine[] = isSkillMd
      ? annotateLines(parseSkillMarkdown(file.content).body)
      : file.content.split("\n").map((text, index) => ({ index, text, isHeading: false, inFence: false }));
    for (const line of lines) {
      for (const d of DANGEROUS_INSTRUCTIONS) {
        if (!d.re.test(line.text)) continue;
        const prohibition = isProhibition(line.text);
        if (prohibition && isSkillMd && isBoundaryLine(line)) continue;
        if (prohibition) {
          f.push(warning(`${d.code}_prohibition_outside_boundaries`, `${p}: a prohibition about ${d.label} should live under "### Boundaries".`, p));
        } else {
          f.push(error(`dangerous_instruction`, `${p} instructs ${d.label}: "${line.text.trim().slice(0, 100)}". Remove it or rephrase as a "Do not …" boundary.`, p));
        }
      }
    }
  }
  return f;
}

/** Mandatory: instruction-only artifact, no secrets, no dangerous instructions, no path traversal. */
export function checkSecurity(skill: GeneratedSkill, _ctx: EvalContext): EvalResult {
  return runCheck("security", true, () => securityFindings(skill));
}
