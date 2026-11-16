/**
 * Cached manifest loaders shared by the manifest, framework, runtime, monorepo, test and build providers.
 * Each manifest is read and parsed at most once per scan.
 */
import type { DiscoveryContext } from "../contracts/index.js";
import {
  parseGoMod,
  parseGradle,
  parsePep508,
  parsePom,
  parseRequirementsTxt,
  parseToml,
  type GoMod,
  type GradleInfo,
  type PomInfo,
  type TomlTable,
} from "./parsers.js";
import { byDepth, filesNamed, isRecord, memo, readRepoFile, stringRecord } from "./util.js";

const MAX_MANIFESTS = 60;

export type Ecosystem = "npm" | "pypi" | "go" | "cargo" | "maven";

export interface DeclaredDependency {
  name: string;
  spec?: string;
  /** "prod", "dev", "optional", "peer", "test", "build", "indirect". */
  scope: string;
}

export interface ManifestDependencies {
  path: string;
  ecosystem: Ecosystem;
  dependencies: DeclaredDependency[];
}

export interface ParsedFile<T> {
  path: string;
  data: T;
}

async function loadParsed<T>(ctx: DiscoveryContext, key: string, files: string[], parse: (text: string) => T): Promise<ParsedFile<T>[]> {
  return memo(ctx, `parsed:${key}`, async () => {
    const out: ParsedFile<T>[] = [];
    for (const p of [...files].sort(byDepth).slice(0, MAX_MANIFESTS)) {
      const text = await readRepoFile(ctx, p);
      if (text === undefined) continue;
      try {
        out.push({ path: p, data: parse(text) });
      } catch {
        // Malformed manifest: skip; providers may still report presence.
      }
    }
    return out;
  });
}

export function loadPackageJsons(ctx: DiscoveryContext): Promise<ParsedFile<Record<string, unknown>>[]> {
  return loadParsed(ctx, "package.json", filesNamed(ctx, "package.json"), (t) => {
    const j: unknown = JSON.parse(t);
    if (!isRecord(j)) throw new Error("package.json is not an object");
    return j;
  });
}

export function loadPyprojects(ctx: DiscoveryContext): Promise<ParsedFile<TomlTable>[]> {
  return loadParsed(ctx, "pyproject", filesNamed(ctx, "pyproject.toml"), parseToml);
}

export function loadCargos(ctx: DiscoveryContext): Promise<ParsedFile<TomlTable>[]> {
  return loadParsed(ctx, "cargo", filesNamed(ctx, "Cargo.toml"), parseToml);
}

export function loadGoMods(ctx: DiscoveryContext): Promise<ParsedFile<GoMod>[]> {
  return loadParsed(ctx, "gomod", filesNamed(ctx, "go.mod"), parseGoMod);
}

export function loadPoms(ctx: DiscoveryContext): Promise<ParsedFile<PomInfo>[]> {
  return loadParsed(ctx, "pom", filesNamed(ctx, "pom.xml"), parsePom);
}

export function loadGradles(ctx: DiscoveryContext): Promise<ParsedFile<GradleInfo>[]> {
  return loadParsed(ctx, "gradle", filesNamed(ctx, "build.gradle", "build.gradle.kts"), parseGradle);
}

export function requirementsFiles(ctx: DiscoveryContext): string[] {
  return ctx.fileIndex.filter((p) => /(^|\/)requirements([-_.][\w-]+)?\.txt$/i.test(p));
}

export function loadRequirements(ctx: DiscoveryContext) {
  return loadParsed(ctx, "requirements", requirementsFiles(ctx), parseRequirementsTxt);
}

// ---------------------------------------------------------------------------
// Normalized dependency lists
// ---------------------------------------------------------------------------

const NPM_SECTIONS: Array<[string, string]> = [
  ["dependencies", "prod"],
  ["devDependencies", "dev"],
  ["peerDependencies", "peer"],
  ["optionalDependencies", "optional"],
];

export function npmDependencies(pkg: Record<string, unknown>): DeclaredDependency[] {
  const out: DeclaredDependency[] = [];
  for (const [section, scope] of NPM_SECTIONS) {
    for (const [name, spec] of Object.entries(stringRecord(pkg[section]))) out.push({ name, spec, scope });
  }
  return out;
}

function pep508List(v: unknown, scope: string): DeclaredDependency[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string")
    .map((s) => parsePep508(s))
    .filter((r): r is { name: string; spec?: string } => !!r)
    .map((r) => ({ ...r, scope }));
}

function poetryTable(v: unknown, scope: string): DeclaredDependency[] {
  if (!isRecord(v)) return [];
  const out: DeclaredDependency[] = [];
  for (const [name, spec] of Object.entries(v)) {
    if (name.toLowerCase() === "python") continue;
    const s = typeof spec === "string" ? spec : isRecord(spec) && typeof spec.version === "string" ? spec.version : undefined;
    out.push({ name: name.toLowerCase(), ...(s ? { spec: s } : {}), scope });
  }
  return out;
}

export function pyprojectDependencies(t: TomlTable): DeclaredDependency[] {
  const out: DeclaredDependency[] = [];
  const project = isRecord(t.project) ? t.project : undefined;
  if (project) {
    out.push(...pep508List(project.dependencies, "prod"));
    if (isRecord(project["optional-dependencies"])) {
      for (const [group, list] of Object.entries(project["optional-dependencies"])) {
        out.push(...pep508List(list, /^(dev|test|tests|testing|lint)$/.test(group) ? "dev" : "optional"));
      }
    }
  }
  if (isRecord(t["dependency-groups"])) {
    for (const list of Object.values(t["dependency-groups"])) out.push(...pep508List(list, "dev"));
  }
  const tool = isRecord(t.tool) ? t.tool : undefined;
  const poetry = tool && isRecord(tool.poetry) ? tool.poetry : undefined;
  if (poetry) {
    out.push(...poetryTable(poetry.dependencies, "prod"));
    out.push(...poetryTable(poetry["dev-dependencies"], "dev"));
    if (isRecord(poetry.group)) {
      for (const g of Object.values(poetry.group)) if (isRecord(g)) out.push(...poetryTable(g.dependencies, "dev"));
    }
  }
  return out;
}

export function cargoDependencies(t: TomlTable): DeclaredDependency[] {
  const out: DeclaredDependency[] = [];
  const sections: Array<[string, string]> = [
    ["dependencies", "prod"],
    ["dev-dependencies", "dev"],
    ["build-dependencies", "build"],
  ];
  const ws = isRecord(t.workspace) ? t.workspace : undefined;
  for (const [section, scope] of sections) {
    for (const table of [t[section], ws?.[section]]) {
      if (!isRecord(table)) continue;
      for (const [name, spec] of Object.entries(table)) {
        const s = typeof spec === "string" ? spec : isRecord(spec) && typeof spec.version === "string" ? spec.version : undefined;
        out.push({ name, ...(s ? { spec: s } : {}), scope });
      }
    }
  }
  return out;
}

export function mavenDependencies(pom: PomInfo): DeclaredDependency[] {
  const out: DeclaredDependency[] = [];
  if (pom.parent) out.push({ name: `${pom.parent.groupId}:${pom.parent.artifactId}`, ...(pom.parent.version ? { spec: pom.parent.version } : {}), scope: "parent" });
  for (const d of pom.dependencies) {
    out.push({ name: `${d.groupId}:${d.artifactId}`, ...(d.version ? { spec: d.version } : {}), scope: d.scope === "test" ? "test" : "prod" });
  }
  return out;
}

export function gradleDependencies(g: GradleInfo): DeclaredDependency[] {
  const out: DeclaredDependency[] = g.plugins.map((p) => ({ name: `plugin:${p.id}`, ...(p.version ? { spec: p.version } : {}), scope: "build" }));
  for (const d of g.dependencies) {
    out.push({ name: `${d.groupId}:${d.artifactId}`, ...(d.version ? { spec: d.version } : {}), scope: d.configuration.startsWith("test") ? "test" : "prod" });
  }
  return out;
}

/** All declared dependencies across supported manifests (cached). */
export function loadAllDependencies(ctx: DiscoveryContext): Promise<ManifestDependencies[]> {
  return memo(ctx, "all-deps", async () => {
    const [pkgs, pys, reqs, gos, cargos, poms, gradles] = await Promise.all([
      loadPackageJsons(ctx),
      loadPyprojects(ctx),
      loadRequirements(ctx),
      loadGoMods(ctx),
      loadCargos(ctx),
      loadPoms(ctx),
      loadGradles(ctx),
    ]);
    const out: ManifestDependencies[] = [
      ...pkgs.map((f) => ({ path: f.path, ecosystem: "npm" as const, dependencies: npmDependencies(f.data) })),
      ...pys.map((f) => ({ path: f.path, ecosystem: "pypi" as const, dependencies: pyprojectDependencies(f.data) })),
      ...reqs.map((f) => ({
        path: f.path,
        ecosystem: "pypi" as const,
        dependencies: f.data.map((r) => ({ name: r.name, ...(r.spec ? { spec: r.spec } : {}), scope: /dev|test/i.test(f.path) ? "dev" : "prod" })),
      })),
      ...gos.map((f) => ({
        path: f.path,
        ecosystem: "go" as const,
        dependencies: f.data.require.map((r) => ({ name: r.path, spec: r.version, scope: r.indirect ? "indirect" : "prod" })),
      })),
      ...cargos.map((f) => ({ path: f.path, ecosystem: "cargo" as const, dependencies: cargoDependencies(f.data) })),
      ...poms.map((f) => ({ path: f.path, ecosystem: "maven" as const, dependencies: mavenDependencies(f.data) })),
      ...gradles.map((f) => ({ path: f.path, ecosystem: "maven" as const, dependencies: gradleDependencies(f.data) })),
    ];
    return out;
  });
}
