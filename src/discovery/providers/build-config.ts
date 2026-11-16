import type { DiscoveryContext, DiscoveryEvidence, DiscoveryProvider } from "../../contracts/index.js";
import { loadPackageJsons, loadPyprojects } from "../manifests.js";
import { parseDockerfileFrom, parseJsonc, parseMakefileTargets, safeYaml } from "../parsers.js";
import { basename, depth, evidenceFactory, filesMatching, isRecord, readRepoFile, stringRecord } from "../util.js";

const BUILD_FILES: Array<{ re: RegExp; tool: string }> = [
  { re: /(^|\/)vite\.config\.(ts|js|mjs|cjs|mts)$/, tool: "vite" },
  { re: /(^|\/)webpack\.config\.(ts|js|mjs|cjs)$/, tool: "webpack" },
  { re: /(^|\/)rollup\.config\.(ts|js|mjs|cjs)$/, tool: "rollup" },
  { re: /(^|\/)tsup\.config\.(ts|js|mjs|cjs|json)$/, tool: "tsup" },
  { re: /(^|\/)esbuild\.config\.(ts|js|mjs|cjs)$/, tool: "esbuild" },
  { re: /(^|\/)next\.config\.(ts|js|mjs|cjs)$/, tool: "next" },
  { re: /(^|\/)nuxt\.config\.(ts|js|mjs)$/, tool: "nuxt" },
  { re: /(^|\/)svelte\.config\.(js|mjs|ts)$/, tool: "svelte" },
  { re: /(^|\/)astro\.config\.(ts|js|mjs)$/, tool: "astro" },
  { re: /(^|\/)(babel\.config\.(js|cjs|mjs|json)|\.babelrc(\.json)?)$/, tool: "babel" },
  { re: /(^|\/)setup\.py$/, tool: "setuptools" },
  { re: /(^|\/)build\.gradle(\.kts)?$/, tool: "gradle" },
  { re: /(^|\/)CMakeLists\.txt$/, tool: "cmake" },
];

const LINT_FILES: Array<{ re: RegExp; tool: string }> = [
  { re: /(^|\/)(eslint\.config\.(js|mjs|cjs|ts)|\.eslintrc(\.(js|cjs|json|ya?ml))?)$/, tool: "ESLint" },
  { re: /(^|\/)(\.prettierrc(\.(js|cjs|json|ya?ml))?|prettier\.config\.(js|cjs|mjs))$/, tool: "Prettier" },
  { re: /(^|\/)biome\.jsonc?$/, tool: "Biome" },
  { re: /(^|\/)(ruff\.toml|\.ruff\.toml)$/, tool: "Ruff" },
  { re: /(^|\/)\.golangci\.ya?ml$/, tool: "golangci-lint" },
  { re: /(^|\/)(mypy\.ini|\.flake8)$/, tool: "Python linting" },
  { re: /(^|\/)\.editorconfig$/, tool: "EditorConfig" },
];

/** P0: build, compiler, container and lint configuration. */
export class BuildConfigProvider implements DiscoveryProvider {
  readonly id = "build-config";
  readonly priority = "P0" as const;

  supports(): boolean {
    return true;
  }

  async discover(ctx: DiscoveryContext): Promise<DiscoveryEvidence[]> {
    const ev = evidenceFactory(this.id, this.priority);
    const out: DiscoveryEvidence[] = [];
    const shallow = (files: string[], max = 3) => files.filter((f) => depth(f) <= max);

    // tsconfig*.json (JSONC)
    for (const p of shallow(filesMatching(ctx, /(^|\/)tsconfig(\.[\w-]+)?\.json$/)).slice(0, 15)) {
      const text = await readRepoFile(ctx, p, 64 * 1024);
      let value: Record<string, unknown> = { tool: "tsc" };
      let claim = `TypeScript configuration ${basename(p)}`;
      try {
        const j = text ? parseJsonc(text) : undefined;
        if (isRecord(j)) {
          const co = isRecord(j.compilerOptions) ? j.compilerOptions : {};
          const pick: Record<string, unknown> = {};
          for (const k of ["target", "module", "moduleResolution", "strict", "jsx", "outDir", "rootDir", "composite", "noUncheckedIndexedAccess"]) {
            if (co[k] !== undefined) pick[k] = co[k];
          }
          value = { tool: "tsc", ...(typeof j.extends === "string" ? { extends: j.extends } : {}), compilerOptions: pick };
          const parts = [pick.target && `target ${String(pick.target)}`, pick.module && `module ${String(pick.module)}`, pick.strict === true && "strict"].filter(Boolean);
          if (parts.length) claim += ` (${parts.join(", ")})`;
        }
      } catch {
        value = { tool: "tsc", parseError: true };
      }
      out.push(ev("build_configuration", p, claim, { value, confidence: value.parseError ? 0.8 : 1 }));
    }

    for (const { re, tool } of BUILD_FILES) {
      for (const p of shallow(filesMatching(ctx, re)).slice(0, 10)) out.push(ev("build_configuration", p, `${tool} build configuration ${basename(p)}`, { value: { tool } }));
    }
    for (const { re, tool } of LINT_FILES) {
      for (const p of shallow(filesMatching(ctx, re), 2).slice(0, 5)) out.push(ev("tooling", p, `${tool} configured (${basename(p)})`, { value: { name: tool } }));
    }

    // Makefile targets
    for (const p of shallow(filesMatching(ctx, /(^|\/)(GNUmakefile|Makefile|makefile)$/), 2)) {
      const text = await readRepoFile(ctx, p, 64 * 1024);
      const targets = text ? parseMakefileTargets(text).slice(0, 30) : [];
      out.push(ev("build_configuration", p, `Makefile${targets.length ? ` with targets ${targets.slice(0, 8).join(", ")}` : ""}`, { value: { tool: "make", targets } }));
    }
    for (const p of shallow(filesMatching(ctx, /(^|\/)justfile$/i), 2)) out.push(ev("build_configuration", p, "just command runner (justfile)", { value: { tool: "just" } }));

    // Containers
    for (const p of shallow(filesMatching(ctx, /(^|\/)(Dockerfile|Containerfile)([.-][\w.-]+)?$/))) {
      const text = await readRepoFile(ctx, p, 64 * 1024);
      const froms = text ? parseDockerfileFrom(text) : [];
      out.push(
        ev("build_configuration", p, `Container build ${basename(p)}${froms.length ? ` (base ${froms.map((f) => `${f.image}${f.tag ? `:${f.tag}` : ""}`).join(", ")})` : ""}`, {
          value: { tool: "docker", stages: froms.length, images: froms.map((f) => `${f.image}${f.tag ? `:${f.tag}` : ""}`) },
        }),
      );
    }
    for (const p of shallow(filesMatching(ctx, /(^|\/)(docker-)?compose(\.[\w-]+)?\.ya?ml$/), 2)) {
      const text = await readRepoFile(ctx, p, 64 * 1024);
      const y = text ? safeYaml(text) : undefined;
      const services = isRecord(y) && isRecord(y.services) ? Object.keys(y.services) : [];
      out.push(ev("build_configuration", p, `Docker Compose${services.length ? ` services: ${services.join(", ")}` : ""}`, { value: { tool: "docker-compose", services } }));
    }

    // package.json build-related scripts
    for (const { path, data } of await loadPackageJsons(ctx)) {
      const scripts = stringRecord(data.scripts);
      const relevant = Object.fromEntries(Object.entries(scripts).filter(([k]) => /^(build|dev|start|lint|typecheck|type-check|check|format|compile)(:|$)/.test(k)));
      if (Object.keys(relevant).length) {
        out.push(ev("build_configuration", path, `npm scripts: ${Object.keys(relevant).join(", ")}`, { value: { tool: "npm-scripts", scripts: relevant } }));
      }
    }
    // pyproject build backend + tool sections
    for (const { path, data } of await loadPyprojects(ctx)) {
      const bs = isRecord(data["build-system"]) ? data["build-system"] : undefined;
      if (typeof bs?.["build-backend"] === "string") out.push(ev("build_configuration", path, `Python build backend ${bs["build-backend"]}`, { value: { tool: "python-build", backend: bs["build-backend"] } }));
      const tool = isRecord(data.tool) ? data.tool : {};
      for (const [k, name] of [["ruff", "Ruff"], ["black", "Black"], ["mypy", "mypy"], ["isort", "isort"]] as const) {
        if (isRecord(tool[k])) out.push(ev("tooling", path, `${name} configured in pyproject.toml`, { value: { name } }));
      }
    }
    return out;
  }
}
