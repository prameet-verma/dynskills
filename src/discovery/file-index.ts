import { opendir } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_EXCLUDED_DIRS, isExcludedPath } from "../core/index.js";

export const DEFAULT_MAX_INDEX_ENTRIES = 20_000;

const EXCLUDED_DIRS: ReadonlySet<string> = new Set(DEFAULT_EXCLUDED_DIRS);

/**
 * List repository files (names only, never contents). Default exclusions and sensitive files are
 * removed, and symlinks are skipped entirely (never followed, never listed). Returns sorted POSIX
 * relative paths, capped at maxEntries.
 *
 * Uses Node's own directory reader instead of a glob library: the exclusions are plain directory
 * and file names, and it keeps the dependency tree free of glob-pattern engines.
 */
export async function buildFileIndex(root: string, opts: { maxEntries?: number } = {}): Promise<string[]> {
  const max = opts.maxEntries ?? DEFAULT_MAX_INDEX_ENTRIES;
  const cwd = path.resolve(root);
  const out: string[] = [];
  // Breadth-first, so very large repositories stop early with the shallow files (manifests,
  // configuration) already collected. Collect up to 2× `max` before applying the cap.
  const hardCap = max * 2;
  const queue: string[] = [""];
  walk: for (let i = 0; i < queue.length; i++) {
    const rel = queue[i] as string;
    let dir;
    try {
      dir = await opendir(rel === "" ? cwd : path.join(cwd, rel));
    } catch {
      continue; // unreadable directory: skip it, as discovery never fails on one path
    }
    const subdirs: string[] = [];
    try {
      for await (const entry of dir) {
        const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
        if (entry.isDirectory()) {
          if (!EXCLUDED_DIRS.has(entry.name)) subdirs.push(childRel);
        } else if (entry.isFile() && !isExcludedPath(childRel)) {
          out.push(childRel);
          if (out.length >= hardCap) break walk; // leaving for-await closes the directory
        }
      }
    } catch {
      // A directory that fails mid-read keeps the entries already collected.
    }
    queue.push(...subdirs.sort());
  }
  const lex = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  if (out.length > max) {
    // Keep shallow files (manifests, configuration) when the cap applies.
    const depthOf = (p: string) => p.split("/").length;
    out.sort((a, b) => depthOf(a) - depthOf(b) || lex(a, b));
    out.length = max;
  }
  return out.sort(lex);
}
