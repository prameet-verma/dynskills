import type { DiscoveryContext, DiscoveryEvidence, DiscoveryProvider } from "../../contracts/index.js";
import { loadPackageJsons, loadPyprojects, requirementsFiles } from "../manifests.js";
import { asString, depth, evidenceFactory, filesNamed, isRecord } from "../util.js";

/** Lockfile / marker → package manager. Lockfiles are identified by name only; never parsed in full. */
const MARKERS: Array<{ file: string; manager: string; confidence: number }> = [
  { file: "pnpm-lock.yaml", manager: "pnpm", confidence: 0.95 },
  { file: "package-lock.json", manager: "npm", confidence: 0.95 },
  { file: "npm-shrinkwrap.json", manager: "npm", confidence: 0.95 },
  { file: "yarn.lock", manager: "yarn", confidence: 0.95 },
  { file: "bun.lockb", manager: "bun", confidence: 0.95 },
  { file: "bun.lock", manager: "bun", confidence: 0.95 },
  { file: "poetry.lock", manager: "poetry", confidence: 0.95 },
  { file: "uv.lock", manager: "uv", confidence: 0.95 },
  { file: "Pipfile.lock", manager: "pipenv", confidence: 0.95 },
  { file: "pdm.lock", manager: "pdm", confidence: 0.95 },
  { file: "Cargo.lock", manager: "cargo", confidence: 0.95 },
  { file: "Cargo.toml", manager: "cargo", confidence: 0.9 },
  { file: "go.mod", manager: "go modules", confidence: 0.95 },
  { file: "pom.xml", manager: "maven", confidence: 0.95 },
  { file: "mvnw", manager: "maven", confidence: 0.95 },
  { file: "build.gradle", manager: "gradle", confidence: 0.95 },
  { file: "build.gradle.kts", manager: "gradle", confidence: 0.95 },
  { file: "gradlew", manager: "gradle", confidence: 0.95 },
  { file: "Gemfile.lock", manager: "bundler", confidence: 0.95 },
  { file: "composer.lock", manager: "composer", confidence: 0.95 },
];

/** P0: package managers from the packageManager field, lockfiles and build-tool markers. */
export class PackageManagerProvider implements DiscoveryProvider {
  readonly id = "package-manager";
  readonly priority = "P0" as const;

  supports(): boolean {
    return true;
  }

  async discover(ctx: DiscoveryContext): Promise<DiscoveryEvidence[]> {
    const ev = evidenceFactory(this.id, this.priority);
    const out: DiscoveryEvidence[] = [];

    for (const { path, data } of await loadPackageJsons(ctx)) {
      const pm = asString(data.packageManager);
      const m = pm ? /^([a-z]+)@([^+\s]+)/.exec(pm) : null;
      if (m?.[1] && m[2]) {
        out.push(ev("package_manager", path, `${m[1]} ${m[2]} declared in packageManager field`, { value: { name: m[1], version: m[2] }, excerpt: `"packageManager": "${pm}"` }));
      }
    }
    for (const { file, manager, confidence } of MARKERS) {
      for (const p of filesNamed(ctx, file).filter((f) => depth(f) <= 2).slice(0, 5)) {
        out.push(ev("package_manager", p, `${manager} (${file} present)`, { value: { name: manager }, confidence }));
      }
    }
    const pyprojects = await loadPyprojects(ctx);
    for (const { path, data } of pyprojects) {
      const tool = isRecord(data.tool) ? data.tool : {};
      if (isRecord(tool.poetry)) out.push(ev("package_manager", path, "poetry ([tool.poetry] in pyproject.toml)", { value: { name: "poetry" } }));
      if (isRecord(tool.uv)) out.push(ev("package_manager", path, "uv ([tool.uv] in pyproject.toml)", { value: { name: "uv" } }));
      if (isRecord(tool.hatch)) out.push(ev("package_manager", path, "hatch ([tool.hatch] in pyproject.toml)", { value: { name: "hatch" } }));
    }
    const hasPyLock = ctx.fileIndex.some((f) => /(^|\/)(poetry\.lock|uv\.lock|Pipfile\.lock|pdm\.lock)$/.test(f));
    if (!hasPyLock) {
      for (const p of requirementsFiles(ctx).filter((f) => depth(f) <= 2).slice(0, 3)) {
        out.push(ev("package_manager", p, `pip (${p} present)`, { value: { name: "pip" }, confidence: 0.8 }));
      }
    }
    return out;
  }
}
