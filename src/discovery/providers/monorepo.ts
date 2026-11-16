import type { DiscoveryContext, DiscoveryEvidence, DiscoveryProvider } from "../../contracts/index.js";
import { loadCargos, loadPackageJsons, loadPoms } from "../manifests.js";
import { parseGoWork, parseGradleSettings, safeYaml } from "../parsers.js";
import { asString, dirname, evidenceFactory, filesNamed, isRecord, joinRel, readRepoFile, workspaceGlobToRegExp } from "../util.js";

const MAX_PACKAGES = 50;

/** P0: workspace / monorepo configuration and the member packages it resolves to. */
export class MonorepoProvider implements DiscoveryProvider {
  readonly id = "monorepo";
  readonly priority = "P0" as const;

  supports(): boolean {
    return true;
  }

  async discover(ctx: DiscoveryContext): Promise<DiscoveryEvidence[]> {
    const ev = evidenceFactory(this.id, this.priority);
    const out: DiscoveryEvidence[] = [];
    const pkgs = await loadPackageJsons(ctx);
    const pkgByDir = new Map(pkgs.map((p) => [dirname(p.path), p]));

    /** Resolve glob patterns relative to `base` against directories containing `marker`. */
    const resolveMembers = (base: string, patterns: string[], marker: string): string[] => {
      const include = patterns.filter((p) => !p.startsWith("!")).map((p) => workspaceGlobToRegExp(joinRel(base, p.replace(/^\.\//, ""))));
      const exclude = patterns.filter((p) => p.startsWith("!")).map((p) => workspaceGlobToRegExp(joinRel(base, p.slice(1).replace(/^\.\//, ""))));
      const dirs = filesNamed(ctx, marker)
        .map(dirname)
        .filter((d) => d !== base && include.some((re) => re.test(d)) && !exclude.some((re) => re.test(d)));
      return [...new Set(dirs)].sort().slice(0, MAX_PACKAGES);
    };
    const emitMembers = (tool: string, members: string[], marker: string) => {
      for (const dir of members) {
        const pkg = marker === "package.json" ? pkgByDir.get(dir) : undefined;
        const name = pkg ? asString(pkg.data.name) : undefined;
        out.push(
          ev("workspace", joinRel(dir, marker), `Workspace package ${name ? `${name} ` : ""}at ${dir}`, {
            value: { tool, path: dir, ...(name ? { name } : {}) },
          }),
        );
      }
    };

    // pnpm-workspace.yaml
    for (const p of filesNamed(ctx, "pnpm-workspace.yaml")) {
      const text = await readRepoFile(ctx, p, 64 * 1024);
      const y = text ? safeYaml(text) : undefined;
      const patterns = isRecord(y) && Array.isArray(y.packages) ? y.packages.filter((x): x is string => typeof x === "string") : [];
      out.push(ev("workspace", p, `pnpm workspace${patterns.length ? ` with packages ${patterns.join(", ")}` : ""}`, { value: { tool: "pnpm", patterns } }));
      emitMembers("pnpm", resolveMembers(dirname(p), patterns, "package.json"), "package.json");
    }

    // package.json workspaces (npm / yarn / bun)
    for (const { path, data } of pkgs) {
      const ws = data.workspaces;
      const patterns = Array.isArray(ws) ? ws : isRecord(ws) && Array.isArray(ws.packages) ? ws.packages : [];
      const list = patterns.filter((x): x is string => typeof x === "string");
      if (!list.length) continue;
      out.push(ev("workspace", path, `package.json workspaces: ${list.join(", ")}`, { value: { tool: "npm-workspaces", patterns: list } }));
      emitMembers("npm-workspaces", resolveMembers(dirname(path), list, "package.json"), "package.json");
    }

    // Monorepo orchestrators.
    for (const [file, tool, label] of [
      ["turbo.json", "turbo", "Turborepo"],
      ["nx.json", "nx", "Nx"],
      ["lerna.json", "lerna", "Lerna"],
      ["rush.json", "rush", "Rush"],
    ] as const) {
      for (const p of filesNamed(ctx, file)) {
        out.push(ev("workspace", p, `${label} monorepo configuration`, { value: { tool } }));
        if (tool === "lerna") {
          const text = await readRepoFile(ctx, p, 64 * 1024);
          try {
            const j: unknown = text ? JSON.parse(text) : undefined;
            const list = isRecord(j) && Array.isArray(j.packages) ? j.packages.filter((x): x is string => typeof x === "string") : [];
            emitMembers("lerna", resolveMembers(dirname(p), list, "package.json"), "package.json");
          } catch {
            /* malformed */
          }
        }
      }
    }

    // go.work
    for (const p of filesNamed(ctx, "go.work")) {
      const text = await readRepoFile(ctx, p, 64 * 1024);
      const uses = text ? parseGoWork(text) : [];
      out.push(ev("workspace", p, `Go workspace using ${uses.join(", ") || "no modules"}`, { value: { tool: "go-work", patterns: uses } }));
      emitMembers("go-work", uses.map((u) => joinRel(dirname(p), u)).filter((d) => ctx.fileIndex.includes(joinRel(d, "go.mod"))), "go.mod");
    }

    // Cargo workspace
    for (const { path, data } of await loadCargos(ctx)) {
      const ws = isRecord(data.workspace) ? data.workspace : undefined;
      const members = Array.isArray(ws?.members) ? ws.members.filter((x): x is string => typeof x === "string") : [];
      if (!ws) continue;
      out.push(ev("workspace", path, `Cargo workspace with members ${members.join(", ")}`, { value: { tool: "cargo", patterns: members } }));
      emitMembers("cargo", resolveMembers(dirname(path), members, "Cargo.toml"), "Cargo.toml");
    }

    // Maven multi-module
    for (const { path, data } of await loadPoms(ctx)) {
      if (!data.modules.length) continue;
      out.push(ev("workspace", path, `Maven multi-module build with modules ${data.modules.join(", ")}`, { value: { tool: "maven", patterns: data.modules } }));
      const members = data.modules.map((m) => joinRel(dirname(path), m)).filter((d) => ctx.fileIndex.includes(joinRel(d, "pom.xml")));
      emitMembers("maven", members, "pom.xml");
    }

    // Gradle multi-project
    for (const p of filesNamed(ctx, "settings.gradle", "settings.gradle.kts")) {
      const text = await readRepoFile(ctx, p, 64 * 1024);
      const includes = text ? parseGradleSettings(text) : [];
      if (!includes.length) continue;
      out.push(ev("workspace", p, `Gradle multi-project build including ${includes.join(", ")}`, { value: { tool: "gradle", patterns: includes } }));
      const members = includes
        .map((i) => joinRel(dirname(p), i))
        .filter((d) => ctx.fileIndex.includes(joinRel(d, "build.gradle")) || ctx.fileIndex.includes(joinRel(d, "build.gradle.kts")));
      for (const d of members) out.push(ev("workspace", d, `Workspace project at ${d}`, { value: { tool: "gradle", path: d } }));
    }
    return out;
  }
}
