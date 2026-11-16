/** §5.2 / §16: redact obvious secrets from text that may reach an LLM or an artifact. */
const PATTERNS: Array<{ name: string; re: RegExp; replace: (m: string, ...g: string[]) => string }> = [
  {
    name: "private_key_block",
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: () => "[REDACTED:private_key]",
  },
  { name: "aws_access_key", re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: () => "[REDACTED:aws_key]" },
  { name: "github_token", re: /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/g, replace: () => "[REDACTED:github_token]" },
  { name: "slack_token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, replace: () => "[REDACTED:slack_token]" },
  { name: "api_key_prefix", re: /\b(sk|pk|rk)[-_](live|test|proj|ant)?[-_]?[A-Za-z0-9_-]{20,}\b/g, replace: () => "[REDACTED:api_key]" },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replace: () => "[REDACTED:jwt]" },
  {
    name: "assignment",
    re: /\b([A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)[A-Za-z0-9_.-]*)(\s*[:=]\s*)(["']?)([^\s"'`,;]{8,})\3/gi,
    replace: (_m, key, sep, q) => `${key}${sep}${q}[REDACTED]${q}`,
  },
  {
    name: "url_credentials",
    re: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:@/]+):([^\s@/]+)@/gi,
    replace: (_m, scheme) => `${scheme}[REDACTED]@`,
  },
];

export interface RedactionResult {
  text: string;
  redactions: number;
}

export function redactSecrets(text: string): RedactionResult {
  let redactions = 0;
  let out = text;
  for (const p of PATTERNS) {
    out = out.replace(p.re, (...args: unknown[]) => {
      redactions++;
      const m = args[0] as string;
      const groups = args.slice(1, -2).map((g) => (g === undefined ? "" : String(g)));
      return p.replace(m, ...groups);
    });
  }
  return { text: out, redactions };
}
