import type { DiscoveryContext, DiscoveryEvidence, DiscoveryProvider } from "../../contracts/index.js";
import { loadAllDependencies, loadCargos, loadGoMods, loadGradles, loadPackageJsons, loadPoms, loadPyprojects, requirementsFiles } from "../manifests.js";
import { asString, evidenceFactory, filesNamed, isRecord, stringRecord } from "../util.js";

const MANIFEST_NAMES = ["package.json", "pyproject.toml", "go.mod", "Cargo.toml", "pom.xml", "build.gradle", "build.gradle.kts", "setup.py", "Pipfile", "Gemfile", "composer.json"];
/** Cap structured dependency values so the packet stays bounded. */
const MAX_DEPS_IN_VALUE = 80;

/** P0: manifests → languages, package identity/scripts and declared dependencies with versions. */
export class ManifestProvider implements DiscoveryProvider {
  readonly id = "manifest";
  readonly priority = "P0" as const;

  supports(ctx: DiscoveryContext): boolean {
    return filesNamed(ctx, ...MANIFEST_NAMES).length > 0 || requirementsFiles(ctx).length > 0;
  }

  async discover(ctx: DiscoveryContext): Promise<DiscoveryEvidence[]> {
    const ev = evidenceFactory(this.id, this.priority);
    const out: DiscoveryEvidence[] = [];
    const [pkgs, pys, gos, cargos, poms, gradles, deps] = await Promise.all([
      loadPackageJsons(ctx),
      loadPyprojects(ctx),
      loadGoMods(ctx),
      loadCargos(ctx),
      loadPoms(ctx),
      loadGradles(ctx),
      loadAllDependencies(ctx),
    ]);

    for (const { path, data } of pkgs) {
      const all = { ...stringRecord(data.dependencies), ...stringRecord(data.devDependencies) };
      const ts = "typescript" in all || ctx.fileIndex.some((f) => f.endsWith(".ts") || f.endsWith(".tsx"));
      out.push(ev("language", path, `${ts ? "TypeScript" : "JavaScript"} package manifest`, { value: { language: ts ? "TypeScript" : "JavaScript" }, confidence: ts && !("typescript" in all) ? 0.9 : 1 }));
      const name = asString(data.name);
      const scripts = stringRecord(data.scripts);
      const value: Record<string, unknown> = { manifest: "npm" };
      if (name) value.name = name;
      if (asString(data.version)) value.version = data.version;
      if (asString(data.type)) value.moduleType = data.type;
      if (Object.keys(scripts).length) value.scripts = scripts;
      out.push(ev("configuration", path, `npm package manifest${name ? ` for ${name}` : ""}`, { value }));
    }
    for (const { path, data } of pys) {
      const project = isRecord(data.project) ? data.project : isRecord(data.tool) && isRecord(data.tool.poetry) ? data.tool.poetry : {};
      const name = asString(project.name);
      out.push(ev("language", path, "Python project manifest (pyproject.toml)", { value: { language: "Python" } }));
      out.push(ev("configuration", path, `Python project${name ? ` ${name}` : ""} defined in pyproject.toml`, { value: { manifest: "pyproject", ...(name ? { name } : {}) } }));
    }
    for (const p of requirementsFiles(ctx)) out.push(ev("language", p, "Python requirements file", { value: { language: "Python" } }));
    for (const p of filesNamed(ctx, "setup.py", "Pipfile")) out.push(ev("language", p, `Python manifest ${p}`, { value: { language: "Python" } }));
    for (const { path, data } of gos) {
      out.push(ev("language", path, `Go module${data.module ? ` ${data.module}` : ""}`, { value: { language: "Go", ...(data.module ? { module: data.module } : {}) } }));
    }
    for (const { path, data } of cargos) {
      const pkg = isRecord(data.package) ? data.package : {};
      const name = asString(pkg.name);
      out.push(ev("language", path, `Rust crate${name ? ` ${name}` : " workspace"}`, { value: { language: "Rust", ...(name ? { name } : {}) } }));
    }
    for (const { path, data } of poms) {
      const kotlin = data.plugins.some((p) => p.artifactId.includes("kotlin"));
      out.push(ev("language", path, `${kotlin ? "Kotlin" : "Java"} Maven project${data.artifactId ? ` ${data.artifactId}` : ""}`, { value: { language: kotlin ? "Kotlin" : "Java" } }));
      out.push(
        ev("configuration", path, `Maven project ${data.groupId ?? data.parent?.groupId ?? "?"}:${data.artifactId ?? "?"}`, {
          value: { manifest: "maven", ...(data.artifactId ? { name: data.artifactId } : {}), ...(data.packaging ? { packaging: data.packaging } : {}), modules: data.modules },
        }),
      );
    }
    for (const { path, data } of gradles) {
      const kotlin = data.plugins.some((p) => p.id.includes("kotlin")) || path.endsWith(".kts");
      out.push(ev("language", path, `${kotlin ? "Kotlin" : "Java"} Gradle project`, { value: { language: kotlin && data.plugins.some((p) => p.id.includes("kotlin")) ? "Kotlin" : "Java" }, confidence: 0.9 }));
    }

    for (const m of deps) {
      if (!m.dependencies.length) continue;
      const groups: Record<string, Record<string, string>> = {};
      for (const d of m.dependencies.slice(0, MAX_DEPS_IN_VALUE)) (groups[d.scope] ??= {})[d.name] = d.spec ?? "*";
      const counts = Object.entries(groups)
        .map(([scope, g]) => `${Object.keys(g).length} ${scope}`)
        .join(", ");
      out.push(
        ev("dependency", m.path, `${m.path} declares ${m.dependencies.length} ${m.ecosystem} dependencies (${counts})`, {
          value: { ecosystem: m.ecosystem, total: m.dependencies.length, ...groups, ...(m.dependencies.length > MAX_DEPS_IN_VALUE ? { truncated: true } : {}) },
        }),
      );
    }
    return out;
  }
}
