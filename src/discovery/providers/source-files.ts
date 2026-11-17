import path from "node:path";
import type { DiscoveryContext, DiscoveryEvidence, DiscoveryProvider } from "../../contracts/index.js";
import { TEST_PATH, isSourcePath, rankPaths, taskKeywords, taskMentionedPaths, taskScopePaths, type PathScore } from "../relevance.js";
import { evidenceFactory, readRepoFile } from "../util.js";

const MAX_SOURCE_EVIDENCE = 25;
/** Related tests added on top of the ranked files. */
const MAX_RELATED_TESTS = 4;
/** Test files whose opening bytes are read to find what they exercise. */
const MAX_TEST_FILES_READ = 40;
const TEST_HEAD_BYTES = 8 * 1024;
/** The files whose tests are looked for: every named file plus the top-ranked others. */
const RELATED_TEST_TARGETS = 5;

/**
 * P1: task-relevant source files, found by scoring repository paths against the files the task
 * names, its scope and its keywords, plus tests that exercise the most relevant files.
 * Emits references only; the context packet builder decides what content to include.
 */
export class SourceFilesProvider implements DiscoveryProvider {
  readonly id = "source-files";
  readonly priority = "P1" as const;

  supports(ctx: DiscoveryContext): boolean {
    return taskKeywords(ctx.task).length > 0 || taskScopePaths(ctx.task).length > 0 || taskMentionedPaths(ctx.task, ctx.fileIndex).length > 0;
  }

  async discover(ctx: DiscoveryContext): Promise<DiscoveryEvidence[]> {
    const ev = evidenceFactory(this.id, this.priority);
    const keywords = taskKeywords(ctx.task);
    const scope = taskScopePaths(ctx.task);
    const mentioned = new Set(taskMentionedPaths(ctx.task, ctx.fileIndex));
    const limit = Math.min(MAX_SOURCE_EVIDENCE, Math.max(1, ctx.limits.maxFiles));
    const ranked = rankPaths(ctx.fileIndex.filter(isSourcePath), keywords, scope, limit, mentioned);

    const byPath = new Map<string, PathScore>(ranked.map((r) => [r.path, r]));
    for (const t of await relatedTests(ctx, ranked)) {
      const current = byPath.get(t.path);
      if (current === undefined || current.score < t.score) byPath.set(t.path, t);
    }
    const all = [...byPath.values()].sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return all.map((r, rank) =>
      ev("source_file", r.path, `Task-relevant source file ${r.path} (matched: ${r.matched.join(", ")})`, {
        value: { score: r.score, rank: rank + 1, matched: r.matched },
        confidence: Math.round(Math.min(0.9, 0.3 + r.score * 0.1) * 100) / 100,
      }),
    );
  }
}

/**
 * Tests that exercise the most relevant non-test files: a test whose file name matches the
 * target's ("inject.test.js" for "inject.js"), or whose opening lines reference it by file name
 * or import path. Each ranks just below the file it tests, so the packet shows how the code
 * under change is tested.
 */
async function relatedTests(ctx: DiscoveryContext, ranked: readonly PathScore[]): Promise<PathScore[]> {
  const isNamed = (r: PathScore) => r.matched.some((m) => m.startsWith("named in task:"));
  const named = ranked.filter(isNamed);
  const targets = [...named, ...ranked.filter((r) => !isNamed(r) && !TEST_PATH.test(r.path)).slice(0, RELATED_TEST_TARGETS)];
  if (targets.length === 0) return [];
  // Tests rank below every file the task names, so they never take budget ahead of them.
  const ceiling = named.length > 0 ? Math.min(...named.map((r) => r.score)) - 0.5 : Infinity;
  const stemOf = (p: string) => path.posix.basename(p).replace(/\.[^.]+$/, "");
  const tests = ctx.fileIndex.filter((f) => TEST_PATH.test(f) && isSourcePath(f)).slice(0, MAX_TEST_FILES_READ);
  const out: PathScore[] = [];
  for (const testPath of tests) {
    const testStem = stemOf(testPath).replace(/[._-](test|spec)$/, "").replace(/^test_/, "").replace(/_test$/, "");
    let head: string | undefined;
    let best: PathScore | undefined;
    for (const target of targets) {
      if (target.path === testPath) continue;
      const base = path.posix.basename(target.path);
      const stem = stemOf(target.path);
      let hit = testStem === stem;
      if (!hit) {
        head ??= (await readRepoFile(ctx, testPath, TEST_HEAD_BYTES)) ?? "";
        hit = head.includes(base) || new RegExp(`[/'"]${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}['"]`).test(head);
      }
      const score = Math.max(1, Math.round(Math.min(target.score - 1, ceiling) * 100) / 100);
      if (hit && (best === undefined || best.score < score)) best = { path: testPath, score, matched: [`tests ${target.path}`] };
    }
    if (best) out.push(best);
  }
  return out.sort((a, b) => b.score - a.score).slice(0, MAX_RELATED_TESTS);
}
