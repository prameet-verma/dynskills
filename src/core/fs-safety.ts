import { open, realpath, lstat } from "node:fs/promises";
import path from "node:path";
import { dsError } from "./errors.js";

/** §5.2 default exclusions (directory names, matched at any depth). */
export const DEFAULT_EXCLUDED_DIRS = [
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".cache",
  "vendor",
  ".dynamic-skills-runtime",
] as const;

/** §5.2 sensitive file patterns (basename globs). These files are never read. */
export const SENSITIVE_FILE_PATTERNS = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "credentials.*",
  "secrets.*",
] as const;

/** fast-glob `ignore` patterns implementing the default exclusions + sensitive files. */
export const DEFAULT_IGNORE_GLOBS: string[] = [
  ...DEFAULT_EXCLUDED_DIRS.map((d) => `**/${d}/**`),
  ...SENSITIVE_FILE_PATTERNS.map((p) => `**/${p}`),
];

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}
const SENSITIVE_RES = SENSITIVE_FILE_PATTERNS.map(globToRegExp);

export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/** True when a repository-relative path is a sensitive file or inside an excluded directory. */
export function isExcludedPath(relPath: string): boolean {
  const parts = toPosix(relPath).split("/");
  if (parts.some((seg) => (DEFAULT_EXCLUDED_DIRS as readonly string[]).includes(seg))) return true;
  return isSensitivePath(relPath);
}

export function isSensitivePath(relPath: string): boolean {
  const base = path.posix.basename(toPosix(relPath));
  return SENSITIVE_RES.some((re) => re.test(base));
}

/**
 * Resolve a repository-relative path, rejecting traversal outside root (§5.2, §16.1).
 * Lexical check only; use resolveRealInsideRoot when symlinks matter.
 */
export function resolveInsideRoot(root: string, relPath: string): string {
  const absRoot = path.resolve(root);
  const abs = path.resolve(absRoot, relPath);
  const rel = path.relative(absRoot, abs);
  if (rel === "" ) return abs;
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw dsError("security", "core", `Path escapes repository root: ${relPath}`, { recoverable: true, fallbackAction: "Skip the file." });
  }
  return abs;
}

/** Like resolveInsideRoot, but also follows symlinks and rejects targets outside root. */
export async function resolveRealInsideRoot(root: string, relPath: string): Promise<string> {
  const abs = resolveInsideRoot(root, relPath);
  const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(abs)]);
  const rel = path.relative(realRoot, realTarget);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw dsError("security", "core", `Symlink escapes repository root: ${relPath}`, { recoverable: true, fallbackAction: "Skip the file." });
  }
  return realTarget;
}

/** Heuristic binary detection: NUL byte within the first 8 KB. */
export function looksBinary(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export interface BoundedRead {
  path: string;
  content: string;
  bytes: number;
  truncated: boolean;
}

export type SkipReason = "sensitive" | "excluded" | "outside_root" | "binary" | "not_found" | "not_file";

/**
 * Safely read a repository text file: rejects sensitive/excluded paths, traversal, unsafe symlinks
 * and binaries; reads at most maxBytes. Returns { skipped } instead of throwing for expected cases.
 */
export async function readTextFileBounded(
  root: string,
  relPath: string,
  maxBytes: number,
): Promise<BoundedRead | { skipped: SkipReason; path: string }> {
  const posix = toPosix(relPath);
  if (isSensitivePath(posix)) return { skipped: "sensitive", path: posix };
  if (isExcludedPath(posix)) return { skipped: "excluded", path: posix };
  let real: string;
  try {
    real = await resolveRealInsideRoot(root, posix);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { skipped: "not_found", path: posix };
    return { skipped: "outside_root", path: posix };
  }
  const st = await lstat(real).catch(() => undefined);
  if (!st?.isFile()) return { skipped: "not_file", path: posix };
  const fh = await open(real, "r");
  try {
    const size = st.size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, 0);
    if (looksBinary(buf)) return { skipped: "binary", path: posix };
    let content = buf.toString("utf8");
    // Avoid a dangling partial multi-byte character at the cut.
    if (size > maxBytes) content = content.replace(/�$/, "");
    return { path: posix, content, bytes: len, truncated: size > maxBytes };
  } finally {
    await fh.close();
  }
}
