import type { DiscoveryContext, DiscoveryEvidence, DiscoveryProvider } from "../../contracts/index.js";
import { readSkillMetadata } from "../skills-inventory.js";
import { dirname, evidenceFactory, readRepoFile } from "../util.js";

const SKILL_RE = /^(?:(.*)\/)?\.(claude|agents|opencode)\/skills\/([^/]+)\/SKILL\.md$/;
const HARNESS: Record<string, string> = { claude: "claude", agents: "codex", opencode: "opencode" };

/** P0: project skills already present in the repository (.claude/.agents/.opencode skills). */
export class ExistingSkillsProvider implements DiscoveryProvider {
  readonly id = "existing-skills";
  readonly priority = "P0" as const;

  supports(ctx: DiscoveryContext): boolean {
    return ctx.fileIndex.some((p) => SKILL_RE.test(p));
  }

  async discover(ctx: DiscoveryContext): Promise<DiscoveryEvidence[]> {
    const ev = evidenceFactory(this.id, this.priority);
    const out: DiscoveryEvidence[] = [];
    for (const p of ctx.fileIndex) {
      const m = SKILL_RE.exec(p);
      if (!m?.[2] || !m[3]) continue;
      if ((m[1] ?? "").split("/").filter(Boolean).length > 2) continue;
      const text = await readRepoFile(ctx, p, 64 * 1024);
      const meta = text !== undefined ? readSkillMetadata(text, m[3]) : undefined;
      if (!meta) continue;
      out.push(
        ev("existing_skill", p, `Existing ${HARNESS[m[2]]} project skill "${meta.name}"`, {
          value: { name: meta.name, description: meta.description, path: dirname(p), harness: HARNESS[m[2]] ?? m[2], scope: "project" },
          ...(meta.description ? { excerpt: meta.description } : {}),
        }),
      );
    }
    return out;
  }
}
