import type { DiscoveryContext, DiscoveryEvidence, DiscoveryProvider } from "../../contracts/index.js";
import { loadCargos, loadGoMods, loadGradles, loadPackageJsons, loadPoms, loadPyprojects } from "../manifests.js";
import { parseDockerfileFrom, parseToml, parseToolVersions, parseVersionFile, runtimeFromImage } from "../parsers.js";
import { asString, depth, evidenceFactory, filesMatching, filesNamed, isRecord, readRepoFile, stringRecord } from "../util.js";

const VERSION_FILES: Record<string, string> = {
  ".nvmrc": "node",
  ".node-version": "node",
  ".python-version": "python",
  ".ruby-version": "ruby",
  ".java-version": "java",
  ".go-version": "go",
  "rust-toolchain": "rust",
};

const TOOL_VERSIONS_MAP: Record<string, string> = {
  nodejs: "node",
  node: "node",
  python: "python",
  golang: "go",
  go: "go",
  java: "java",
  rust: "rust",
  ruby: "ruby",
  bun: "bun",
  deno: "deno",
  pnpm: "pnpm",
  yarn: "yarn",
};

const RUNTIME_LABEL: Record<string, string> = { node: "Node.js", python: "Python", go: "Go", java: "Java", rust: "Rust", ruby: "Ruby", bun: "Bun", deno: "Deno" };

const label = (r: string) => RUNTIME_LABEL[r] ?? r;

/**
 * P0: runtime versions from every source independently (version files, engines, Dockerfiles,
 * manifests). Conflicting declarations are kept as separate evidence entries so they surface.
 */
export class RuntimeProvider implements DiscoveryProvider {
  readonly id = "runtime";
  readonly priority = "P0" as const;

  supports(): boolean {
    return true;
  }

  async discover(ctx: DiscoveryContext): Promise<DiscoveryEvidence[]> {
    const ev = evidenceFactory(this.id, this.priority);
    const out: DiscoveryEvidence[] = [];
    const add = (runtime: string, version: string, source: string, via: string, opts: { line?: number; excerpt?: string; constraint?: boolean; confidence?: number } = {}) => {
      out.push(
        ev("runtime", source, `${label(runtime)} ${version} (${via})`, {
          value: { runtime, version, ...(opts.constraint ? { constraint: true } : {}) },
          ...(opts.line !== undefined ? { line: opts.line } : {}),
          ...(opts.excerpt !== undefined ? { excerpt: opts.excerpt } : {}),
          confidence: opts.confidence ?? 1,
        }),
      );
    };

    // Version files.
    for (const [name, runtime] of Object.entries(VERSION_FILES)) {
      for (const p of filesNamed(ctx, name).filter((f) => depth(f) <= 2)) {
        const text = await readRepoFile(ctx, p, 4096);
        const v = text !== undefined ? parseVersionFile(text) : undefined;
        if (v) add(runtime, v, p, name, { excerpt: v });
      }
    }
    for (const p of filesNamed(ctx, "rust-toolchain.toml").filter((f) => depth(f) <= 2)) {
      const text = await readRepoFile(ctx, p, 4096);
      try {
        const t = text ? parseToml(text) : {};
        const ch = isRecord(t.toolchain) ? asString(t.toolchain.channel) : undefined;
        if (ch) add("rust", ch, p, "rust-toolchain.toml");
      } catch {
        /* malformed */
      }
    }
    for (const p of filesNamed(ctx, ".tool-versions").filter((f) => depth(f) <= 2)) {
      const text = await readRepoFile(ctx, p, 8192);
      for (const t of text ? parseToolVersions(text) : []) {
        const runtime = TOOL_VERSIONS_MAP[t.tool];
        if (runtime) add(runtime, t.version, p, ".tool-versions", { line: t.line });
      }
    }

    // package.json engines + volta.
    for (const { path, data } of await loadPackageJsons(ctx)) {
      const engines = stringRecord(data.engines);
      for (const [engine, range] of Object.entries(engines)) {
        if (engine === "node" || engine === "bun" || engine === "deno") add(engine, range, path, "package.json engines", { constraint: true, excerpt: `"${engine}": "${range}"` });
      }
      const volta = stringRecord(data.volta);
      if (volta.node) add("node", volta.node, path, "package.json volta");
    }

    // Dockerfiles.
    for (const p of filesMatching(ctx, /(^|\/)(Dockerfile|Containerfile)([.-][\w.-]+)?$|\.dockerfile$/i).filter((f) => depth(f) <= 3)) {
      const text = await readRepoFile(ctx, p, 64 * 1024);
      for (const from of text ? parseDockerfileFrom(text) : []) {
        const r = runtimeFromImage(from);
        if (r?.version) add(r.runtime, r.version, p, `Dockerfile FROM ${from.image}:${from.tag ?? "latest"}`, { line: from.line, excerpt: `FROM ${from.image}${from.tag ? `:${from.tag}` : ""}` });
      }
    }

    // Python.
    for (const { path, data } of await loadPyprojects(ctx)) {
      const project = isRecord(data.project) ? data.project : undefined;
      const rp = asString(project?.["requires-python"]);
      if (rp) add("python", rp, path, "pyproject requires-python", { constraint: true });
      const tool = isRecord(data.tool) ? data.tool : undefined;
      const poetryDeps = tool && isRecord(tool.poetry) && isRecord(tool.poetry.dependencies) ? tool.poetry.dependencies : undefined;
      const py = asString(poetryDeps?.python);
      if (py) add("python", py, path, "poetry python dependency", { constraint: true });
    }

    // Go.
    for (const { path, data } of await loadGoMods(ctx)) {
      if (data.go) add("go", data.go, path, "go.mod go directive");
      if (data.toolchain) add("go", data.toolchain.replace(/^go/, ""), path, "go.mod toolchain");
    }

    // Rust.
    for (const { path, data } of await loadCargos(ctx)) {
      const pkg = isRecord(data.package) ? data.package : isRecord(data.workspace) && isRecord(data.workspace.package) ? data.workspace.package : undefined;
      const rv = asString(pkg?.["rust-version"]);
      if (rv) add("rust", rv, path, "Cargo.toml rust-version", { constraint: true });
    }

    // Java.
    for (const { path, data } of await loadPoms(ctx)) {
      const v = data.properties["java.version"] ?? data.properties["maven.compiler.release"] ?? data.properties["maven.compiler.source"];
      if (v) add("java", v, path, "pom.xml properties");
    }
    for (const { path, data } of await loadGradles(ctx)) {
      if (data.javaVersion) add("java", data.javaVersion, path, "Gradle java toolchain");
    }
    return out;
  }
}
