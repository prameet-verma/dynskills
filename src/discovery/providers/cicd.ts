import type { DiscoveryContext, DiscoveryEvidence, DiscoveryProvider } from "../../contracts/index.js";
import { safeYaml } from "../parsers.js";
import { evidenceFactory, filesMatching, isRecord, readRepoFile } from "../util.js";

const SYSTEMS: Array<{ re: RegExp; system: string }> = [
  { re: /^\.github\/workflows\/[^/]+\.ya?ml$/, system: "GitHub Actions" },
  { re: /^\.gitlab-ci\.ya?ml$/, system: "GitLab CI" },
  { re: /^\.circleci\/config\.ya?ml$/, system: "CircleCI" },
  { re: /^Jenkinsfile$/, system: "Jenkins" },
  { re: /^azure-pipelines\.ya?ml$/, system: "Azure Pipelines" },
  { re: /^bitbucket-pipelines\.ya?ml$/, system: "Bitbucket Pipelines" },
  { re: /^\.travis\.ya?ml$/, system: "Travis CI" },
  { re: /^\.buildkite\/pipeline\.ya?ml$/, system: "Buildkite" },
];

const MAX_COMMANDS = 12;

/** P1: CI/CD pipelines and the commands they run. */
export class CicdProvider implements DiscoveryProvider {
  readonly id = "cicd";
  readonly priority = "P1" as const;

  supports(ctx: DiscoveryContext): boolean {
    return SYSTEMS.some(({ re }) => ctx.fileIndex.some((p) => re.test(p)));
  }

  async discover(ctx: DiscoveryContext): Promise<DiscoveryEvidence[]> {
    const ev = evidenceFactory(this.id, this.priority);
    const out: DiscoveryEvidence[] = [];
    for (const { re, system } of SYSTEMS) {
      for (const p of filesMatching(ctx, re).slice(0, 20)) {
        const value: Record<string, unknown> = { system };
        let claim = `${system} pipeline ${p}`;
        if (p.endsWith(".yml") || p.endsWith(".yaml")) {
          const text = await readRepoFile(ctx, p, 128 * 1024);
          const y = text ? safeYaml(text) : undefined;
          if (isRecord(y)) {
            if (typeof y.name === "string") {
              value.name = y.name;
              claim = `${system} workflow "${y.name}" (${p})`;
            }
            if (y.on !== undefined) value.triggers = typeof y.on === "string" ? [y.on] : Array.isArray(y.on) ? y.on : isRecord(y.on) ? Object.keys(y.on) : [];
            const jobs = isRecord(y.jobs) ? y.jobs : undefined;
            if (jobs) value.jobs = Object.keys(jobs);
            value.commands = collectCommands(jobs ?? y).slice(0, MAX_COMMANDS);
          }
        }
        out.push(ev("ci_cd", p, claim, { value }));
      }
    }
    return out;
  }
}

/** Collect `run:` / `script:` commands from a CI YAML tree (bounded walk). */
function collectCommands(node: unknown, acc: string[] = [], depth = 0): string[] {
  if (depth > 6 || acc.length >= MAX_COMMANDS) return acc;
  if (Array.isArray(node)) {
    for (const n of node) collectCommands(n, acc, depth + 1);
  } else if (isRecord(node)) {
    for (const [k, v] of Object.entries(node)) {
      if ((k === "run" || k === "script" || k === "command") && (typeof v === "string" || Array.isArray(v))) {
        for (const c of Array.isArray(v) ? v : [v]) if (typeof c === "string") acc.push(c.trim().split("\n")[0]?.slice(0, 160) ?? "");
      } else if (k === "uses" && typeof v === "string") {
        acc.push(`uses: ${v}`);
      } else collectCommands(v, acc, depth + 1);
    }
  }
  return acc;
}
