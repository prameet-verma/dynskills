import path from "node:path";
import type { DiscoveryContext, DiscoveryEvidence, DiscoveryPriority, EvidenceKind } from "../contracts/index.js";
import { evidenceId, readTextFileBounded, redactSecrets } from "../core/index.js";

/** Maximum bytes read for a manifest/configuration file during discovery. */
export const DISCOVERY_READ_BYTES = 256 * 1024;
const EXCERPT_CHARS = 200;

export const PRIORITY_RANK: Record<DiscoveryPriority, number> = { P0: 0, P1: 1, P2: 2 };

/** Contract declaration order; used for deterministic evidence ordering. */
export const KIND_ORDER: readonly EvidenceKind[] = [
  "language",
  "runtime",
  "framework",
  "package_manager",
  "tooling",
  "dependency",
  "workspace",
  "directory",
  "entrypoint",
  "instructions",
  "configuration",
  "test_configuration",
  "build_configuration",
  "ci_cd",
  "existing_skill",
  "documentation",
  "source_file",
];

export function compareEvidence(a: DiscoveryEvidence, b: DiscoveryEvidence): number {
  return (
    PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
    KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
    cmp(a.source, b.source) ||
    cmp(a.claim, b.claim) ||
    cmp(a.id, b.id)
  );
}

export function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Short, single-line-ish, redacted excerpt. */
export function makeExcerpt(text: string, max = EXCERPT_CHARS): string {
  const redacted = redactSecrets(text.trim()).text;
  return redacted.length > max ? `${redacted.slice(0, max - 1)}…` : redacted;
}

export interface EvidenceOptions {
  value?: DiscoveryEvidence["value"];
  excerpt?: string;
  line?: number;
  confidence?: number;
}

/** Evidence factory bound to a provider. */
export function evidenceFactory(providerId: string, priority: DiscoveryPriority) {
  return (kind: EvidenceKind, source: string, claim: string, opts: EvidenceOptions = {}): DiscoveryEvidence => {
    const e: DiscoveryEvidence = {
      id: evidenceId(providerId, kind, source, claim),
      providerId,
      kind,
      priority,
      claim,
      source,
      confidence: opts.confidence ?? 1,
    };
    if (opts.value !== undefined) e.value = opts.value;
    if (opts.excerpt !== undefined && opts.excerpt.trim() !== "") e.excerpt = makeExcerpt(opts.excerpt);
    if (opts.line !== undefined) e.line = opts.line;
    return e;
  };
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error("Aborted");
}

export function basename(p: string): string {
  return path.posix.basename(p);
}

export function dirname(p: string): string {
  const d = path.posix.dirname(p);
  return d === "" ? "." : d;
}

export function depth(p: string): number {
  return p.split("/").length - 1;
}

/** Join a repository-relative directory and a name ("." aware). */
export function joinRel(dir: string, name: string): string {
  return dir === "." || dir === "" ? name : `${dir}/${name}`;
}

// ---------------------------------------------------------------------------
// Per-scan memoization (one DiscoveryContext object is shared by all providers)
// ---------------------------------------------------------------------------

const memoStore = new WeakMap<DiscoveryContext, Map<string, Promise<unknown>>>();

export function memo<T>(ctx: DiscoveryContext, key: string, fn: () => Promise<T>): Promise<T> {
  let m = memoStore.get(ctx);
  if (!m) {
    m = new Map();
    memoStore.set(ctx, m);
  }
  let p = m.get(key) as Promise<T> | undefined;
  if (!p) {
    p = fn();
    m.set(key, p);
  }
  return p;
}

/** Bounded, safe read of a repository file (cached per scan). undefined when skipped or missing. */
export function readRepoFile(ctx: DiscoveryContext, rel: string, maxBytes = DISCOVERY_READ_BYTES): Promise<string | undefined> {
  return memo(ctx, `read:${maxBytes}:${rel}`, async () => {
    const r = await readTextFileBounded(ctx.root, rel, maxBytes).catch(() => undefined);
    if (!r || "skipped" in r) return undefined;
    return r.content;
  });
}

// ---------------------------------------------------------------------------
// File index queries
// ---------------------------------------------------------------------------

export function filesNamed(ctx: DiscoveryContext, ...names: string[]): string[] {
  const set = new Set(names.map((n) => n.toLowerCase()));
  return ctx.fileIndex.filter((p) => set.has(basename(p).toLowerCase()));
}

export function filesMatching(ctx: DiscoveryContext, re: RegExp): string[] {
  return ctx.fileIndex.filter((p) => re.test(p));
}

/** Sort shallow paths first, then lexicographically. */
export function byDepth(a: string, b: string): number {
  return depth(a) - depth(b) || cmp(a, b);
}

/** Convert a simple workspace glob ("packages/*", "apps/**", "libs/a") to a RegExp over directory paths. */
export function workspaceGlobToRegExp(glob: string): RegExp {
  let g = glob.trim().replace(/^\.\//, "").replace(/\/+$/, "");
  if (g === "" || g === ".") g = ".";
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i] as string;
    if (c === "*") {
      if (g[i + 1] === "*") {
        re += ".*";
        i++;
        if (g[i + 1] === "/") i++;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** Lowercase tokens of a path or sentence, split on separators and camelCase boundaries. */
export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Very small stemmer: plural and common verb suffixes. */
export function stem(word: string): string {
  let w = word;
  if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith("ies")) w = `${w.slice(0, -3)}y`;
  else if (w.length > 4 && w.endsWith("es") && /(ss|x|ch|sh)es$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
  return w;
}

/** Strip a version range/prefix: "^18.3.1" → "18.3.1", ">=0.115,<1" → "0.115", "v1.2" → "1.2". */
export function normalizeVersion(spec: string | undefined): string | undefined {
  if (!spec) return undefined;
  const m = /(\d+(?:\.\d+)*(?:[-+.][0-9A-Za-z.-]+)?)/.exec(spec);
  return m?.[1];
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function stringRecord(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(v)) return out;
  for (const [k, val] of Object.entries(v)) if (typeof val === "string") out[k] = val;
  return out;
}
