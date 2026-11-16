import fg from "fast-glob";
import path from "node:path";
import { DEFAULT_IGNORE_GLOBS, isExcludedPath, toPosix } from "../core/index.js";

export const DEFAULT_MAX_INDEX_ENTRIES = 20_000;

/**
 * List repository files (names only, never contents). Default exclusions and sensitive files are
 * removed; symlinks are not followed. Sorted POSIX relative paths, capped at maxEntries.
 */
export async function buildFileIndex(root: string, opts: { maxEntries?: number } = {}): Promise<string[]> {
  const max = opts.maxEntries ?? DEFAULT_MAX_INDEX_ENTRIES;
  const cwd = path.resolve(root);
  const out: string[] = [];
  const stream = fg.stream("**/*", {
    cwd,
    dot: true,
    onlyFiles: true,
    followSymbolicLinks: false,
    ignore: DEFAULT_IGNORE_GLOBS,
    suppressErrors: true,
    unique: true,
  });
  // Stream so very large repositories stop early instead of materializing every path.
  // Collect up to 2× `max` before applying the cap (fast-glob order is filesystem order).
  const hardCap = max * 2;
  for await (const entry of stream) {
    const rel = toPosix(String(entry));
    if (isExcludedPath(rel)) continue;
    out.push(rel);
    if (out.length >= hardCap) break;
  }
  (stream as unknown as { destroy?: () => void }).destroy?.();
  const lex = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  if (out.length > max) {
    // Keep shallow files (manifests, configuration) when the cap applies.
    const depthOf = (p: string) => p.split("/").length;
    out.sort((a, b) => depthOf(a) - depthOf(b) || lex(a, b));
    out.length = max;
  }
  return out.sort(lex);
}
