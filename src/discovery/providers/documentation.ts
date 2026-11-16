import type { DiscoveryContext, DiscoveryEvidence, DiscoveryProvider } from "../../contracts/index.js";
import { byDepth, depth, evidenceFactory, readRepoFile } from "../util.js";

const TOP_DOCS = /^(?:[^/]+\/){0,2}(README|CONTRIBUTING|ARCHITECTURE|DESIGN|DEVELOPMENT|HACKING|SECURITY)(\.[a-z]+)?$/i;
const DOC_DIRS = /^(?:[^/]+\/)?(docs?|documentation|adr|adrs)\/.+\.(md|mdx|rst|adoc|txt)$/i;
const MAX_DOCS = 25;

export function isDocumentationPath(p: string): boolean {
  return TOP_DOCS.test(p) || DOC_DIRS.test(p);
}

/** P1: READMEs, contributor/architecture docs and docs/ directories (title only, no full content). */
export class DocumentationProvider implements DiscoveryProvider {
  readonly id = "documentation";
  readonly priority = "P1" as const;

  supports(ctx: DiscoveryContext): boolean {
    return ctx.fileIndex.some(isDocumentationPath);
  }

  async discover(ctx: DiscoveryContext): Promise<DiscoveryEvidence[]> {
    const ev = evidenceFactory(this.id, this.priority);
    const out: DiscoveryEvidence[] = [];
    const docs = ctx.fileIndex.filter(isDocumentationPath).sort(byDepth).slice(0, MAX_DOCS);
    for (const p of docs) {
      const text = await readRepoFile(ctx, p, 4096);
      const title = text
        ?.split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => /^#{1,3}\s+\S/.test(l) || /^=+\s*\S/.test(l))
        ?.replace(/^[#=\s]+/, "");
      const isAdr = /(^|\/)adrs?\//i.test(p);
      out.push(
        ev("documentation", p, `${isAdr ? "Architecture decision record" : "Documentation"} ${p}${title ? `: ${title}` : ""}`, {
          value: { path: p, ...(title ? { title } : {}), depth: depth(p) },
          ...(title ? { excerpt: title } : {}),
        }),
      );
    }
    return out;
  }
}
