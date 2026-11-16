import type { DiscoveryContext, DiscoveryEvidence, DiscoveryProvider } from "../../contracts/index.js";
import { isSourcePath, rankPaths, taskKeywords, taskScopePaths } from "../relevance.js";
import { evidenceFactory } from "../util.js";

const MAX_SOURCE_EVIDENCE = 25;

/**
 * P1: task-relevant source files, found by scoring repository paths against task keywords and scope.
 * Emits references only; the context packet builder decides what content to include.
 */
export class SourceFilesProvider implements DiscoveryProvider {
  readonly id = "source-files";
  readonly priority = "P1" as const;

  supports(ctx: DiscoveryContext): boolean {
    return taskKeywords(ctx.task).length > 0 || taskScopePaths(ctx.task).length > 0;
  }

  async discover(ctx: DiscoveryContext): Promise<DiscoveryEvidence[]> {
    const ev = evidenceFactory(this.id, this.priority);
    const keywords = taskKeywords(ctx.task);
    const scope = taskScopePaths(ctx.task);
    const limit = Math.min(MAX_SOURCE_EVIDENCE, Math.max(1, ctx.limits.maxFiles));
    const ranked = rankPaths(ctx.fileIndex.filter(isSourcePath), keywords, scope, limit);
    return ranked.map((r, rank) =>
      ev("source_file", r.path, `Task-relevant source file ${r.path} (matched: ${r.matched.join(", ")})`, {
        value: { score: r.score, rank: rank + 1, matched: r.matched },
        confidence: Math.round(Math.min(0.9, 0.3 + r.score * 0.1) * 100) / 100,
      }),
    );
  }
}
