import type { TaskIntent } from "../contracts/index.js";
import { stem, tokenize } from "./util.js";

const STOPWORDS = new Set(
  (
    "a an the and or but if then else when while for to of in on at by with from into onto over under about as is are was were be been being " +
    "it its this that these those there here we our you your they their i me my he she his her them us " +
    "add adds added adding implement implementing implementation create creating make making update updating fix fixing change changing " +
    "new support use using used should must can could would will need needs needed want wants please also just some any all each every " +
    "feature features code file files function functions method methods thing things way ways work works project repo repository " +
    "able so such than too very via etc e g ie eg do does done get gets set sets"
  ).split(/\s+/),
);

export const SOURCE_EXTENSIONS = new Set([
  "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "py", "go", "java", "kt", "kts", "scala", "rs", "rb", "php", "cs", "swift",
  "c", "h", "cc", "cpp", "hpp", "ex", "exs", "dart", "vue", "svelte", "sql", "graphql", "gql", "proto",
]);

export function isSourcePath(p: string): boolean {
  const dot = p.lastIndexOf(".");
  return dot > p.lastIndexOf("/") && SOURCE_EXTENSIONS.has(p.slice(dot + 1).toLowerCase());
}

/** Distinct stemmed keywords from free text, stopwords removed. */
export function extractKeywords(text: string): string[] {
  const out = new Set<string>();
  for (const t of tokenize(text)) {
    if (t.length < 3 || STOPWORDS.has(t) || /^\d+$/.test(t)) continue;
    out.add(stem(t));
  }
  return [...out];
}

/** Path-like tokens in free text ("lib/script-engine.js", "inject.js"); resolved against real files by taskMentionedPaths. */
const PATH_MENTION = /(?<![\w@/.-])\.?\/?((?:[\w@.-]+\/)*[\w@-][\w@.-]*\.[A-Za-z][A-Za-z0-9]{0,5})(?![\w/])/g;

function taskText(task: TaskIntent): string {
  return [task.description, task.expectedOutcome ?? "", ...(task.constraints ?? [])].join(" ");
}

/**
 * Keywords from the task, ignoring file paths it names. A named path is matched as a file
 * (taskMentionedPaths); splitting it into words would make "lib" in "lib/script-engine.js" match
 * every file under lib/.
 */
export function taskKeywords(task: TaskIntent): string[] {
  const text = [taskText(task).replace(PATH_MENTION, " "), ...(task.scope ?? []).filter((s) => !s.includes("/") && !s.includes("."))].join(" ");
  return extractKeywords(text);
}

/**
 * Repository files the task names explicitly: an exact relative path, a unique path suffix
 * ("content/inject.js"), or a unique file name ("inject.js"). Mentions that match no file, or
 * several files, are ignored.
 */
export function taskMentionedPaths(task: TaskIntent, fileIndex: readonly string[]): string[] {
  const files = new Set(fileIndex);
  const out = new Set<string>();
  for (const m of taskText(task).matchAll(PATH_MENTION)) {
    const mention = (m[1] ?? "").replace(/^\.\//, "");
    if (!mention) continue;
    if (files.has(mention)) {
      out.add(mention);
      continue;
    }
    const suffix = `/${mention}`;
    const hits = fileIndex.filter((f) => f.endsWith(suffix));
    if (hits.length === 1) out.add(hits[0] as string);
  }
  return [...out];
}

/** Task scope entries that look like repository paths (normalized, no leading ./ or trailing /). */
export function taskScopePaths(task: TaskIntent): string[] {
  return (task.scope ?? [])
    .filter((s) => s.includes("/") || s.includes("."))
    .map((s) => s.trim().replace(/^\.\//, "").replace(/\/+$/, ""))
    .filter((s) => s && !s.startsWith("..") && !s.startsWith("/"));
}

export interface PathScore {
  path: string;
  score: number;
  matched: string[];
}

export const TEST_PATH = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z]+$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$/;

/** Score bonus for a file the task names explicitly; outranks any keyword match. */
export const MENTIONED_PATH_SCORE = 10;

/** Score a path against keywords, scope paths and files the task names. 0 = irrelevant. */
export function scorePath(p: string, keywords: string[], scopePaths: string[] = [], mentioned: ReadonlySet<string> = new Set()): PathScore {
  const segments = p.split("/");
  const file = segments[segments.length - 1] ?? "";
  const fileTokens = tokenize(file.replace(/\.[^.]+$/, "")).map(stem);
  const dirTokens = segments.slice(0, -1).flatMap((s) => tokenize(s)).map(stem);
  let score = 0;
  const matched = new Set<string>();
  for (const k of keywords) {
    let best = 0;
    for (const t of fileTokens) best = Math.max(best, t === k ? 3 : k.length >= 4 && t.length >= 4 && (t.startsWith(k) || k.startsWith(t)) ? 1.5 : 0);
    // A folder name alone ("lib", "content") is weak evidence that a file matters.
    for (const t of dirTokens) best = Math.max(best, t === k ? 1 : k.length >= 4 && t.length >= 4 && (t.startsWith(k) || k.startsWith(t)) ? 0.5 : 0);
    if (best > 0) {
      score += best;
      matched.add(k);
    }
  }
  if (mentioned.has(p)) {
    score += MENTIONED_PATH_SCORE;
    matched.add(`named in task: ${p}`);
  }
  for (const s of scopePaths) {
    if (p === s || p.startsWith(`${s}/`)) {
      score += 4;
      matched.add(`scope:${s}`);
    }
  }
  if (score > 0 && TEST_PATH.test(p) && !mentioned.has(p)) score -= 0.5;
  // Slight preference for shallower paths, never enough to outrank a keyword match.
  if (score > 0) score -= Math.min(segments.length, 10) * 0.01;
  return { path: p, score: Math.round(score * 100) / 100, matched: [...matched] };
}

/** Rank candidate paths by relevance; ties broken lexicographically for determinism. */
export function rankPaths(
  paths: readonly string[],
  keywords: string[],
  scopePaths: string[],
  limit: number,
  mentioned: ReadonlySet<string> = new Set(),
): PathScore[] {
  if (!keywords.length && !scopePaths.length && !mentioned.size) return [];
  return paths
    .map((p) => scorePath(p, keywords, scopePaths, mentioned))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .slice(0, limit);
}
