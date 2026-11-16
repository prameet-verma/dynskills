import type { DiscoveryContext, DiscoveryEvidence, DiscoveryProvider } from "../../contracts/index.js";
import { basename, evidenceFactory, readRepoFile } from "../util.js";

interface InstructionRule {
  /** Matches the path suffix; group 1 is the anchor directory prefix (may be empty). */
  re: RegExp;
  harness: string;
}

const RULES: InstructionRule[] = [
  { re: /^(?:(.*)\/)?\.claude\/CLAUDE\.md$/, harness: "claude" },
  { re: /^(?:(.*)\/)?CLAUDE(?:\.local)?\.md$/, harness: "claude" },
  { re: /^(?:(.*)\/)?AGENTS(?:\.override)?\.md$/, harness: "codex" },
  { re: /^(?:(.*)\/)?GEMINI\.md$/, harness: "gemini" },
  { re: /^(?:(.*)\/)?\.github\/copilot-instructions\.md$/, harness: "copilot" },
  { re: /^(?:(.*)\/)?\.github\/instructions\/[^/]+\.instructions\.md$/, harness: "copilot" },
  { re: /^(?:(.*)\/)?\.cursorrules$/, harness: "cursor" },
  { re: /^(?:(.*)\/)?\.cursor\/rules\/[^/]+$/, harness: "cursor" },
  { re: /^(?:(.*)\/)?\.windsurfrules$/, harness: "windsurf" },
];

/** Maximum directory depth of the anchor (the directory the instruction applies to). */
const MAX_ANCHOR_DEPTH = 2;

export function matchInstructionFile(p: string): { harness: string; anchor: string } | undefined {
  for (const { re, harness } of RULES) {
    const m = re.exec(p);
    if (!m) continue;
    const anchor = m[1] ?? "";
    const anchorDepth = anchor === "" ? 0 : anchor.split("/").length;
    if (anchorDepth > MAX_ANCHOR_DEPTH) return undefined;
    return { harness, anchor: anchor || "." };
  }
  return undefined;
}

/** P0: agent instruction files (CLAUDE.md, AGENTS.md, GEMINI.md, Copilot, Cursor, Windsurf). Untrusted data. */
export class InstructionsProvider implements DiscoveryProvider {
  readonly id = "instructions";
  readonly priority = "P0" as const;

  supports(): boolean {
    return true;
  }

  async discover(ctx: DiscoveryContext): Promise<DiscoveryEvidence[]> {
    const ev = evidenceFactory(this.id, this.priority);
    const out: DiscoveryEvidence[] = [];
    for (const p of ctx.fileIndex) {
      // Skills directories are inventoried separately.
      if (/(^|\/)\.(claude|agents|opencode)\/skills\//.test(p)) continue;
      const m = matchInstructionFile(p);
      if (!m) continue;
      const text = await readRepoFile(ctx, p, 4096);
      const firstLines = text
        ?.split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, 3)
        .join(" ");
      out.push(
        ev("instructions", p, `${m.harness} agent instructions in ${basename(p)}${m.anchor === "." ? "" : ` for ${m.anchor}/`}`, {
          value: { harness: m.harness, appliesTo: m.anchor, trusted: false },
          ...(firstLines ? { excerpt: firstLines } : {}),
        }),
      );
    }
    return out;
  }
}
