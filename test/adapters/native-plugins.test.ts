import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";
import { pluginSourceDir } from "../../src/adapter-sdk/index.js";
import { parseSkillMd } from "../../src/storage/index.js";
import { tmpDir } from "../storage/helpers.js";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BOOTSTRAP = path.join(ROOT, "skills/dynamic-skill-bootstrap/SKILL.md");
const CLAUDE = path.join(ROOT, "plugins/claude-code");
const CODEX = path.join(ROOT, "plugins/codex");

async function json(p: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(p, "utf8")) as Record<string, unknown>;
}

describe("pluginSourceDir", () => {
  it("resolves plugins/<harness> from the package root", () => {
    expect(pluginSourceDir("claude")).toBe(CLAUDE);
    expect(pluginSourceDir("codex")).toBe(CODEX);
    expect(pluginSourceDir("opencode")).toBe(path.join(ROOT, "plugins/opencode"));
  });
});

describe("packaged plugin manifests", () => {
  it("Claude Code marketplace and plugin manifest have the required fields", async () => {
    const pkg = await json(path.join(ROOT, "package.json"));
    const market = await json(path.join(CLAUDE, ".claude-plugin/marketplace.json"));
    expect(market.name).toBe("dynamic-skills-local");
    expect((market.owner as { name?: unknown }).name).toEqual(expect.any(String));
    const plugins = market.plugins as Array<Record<string, unknown>>;
    expect(plugins).toHaveLength(1);
    expect(plugins[0]).toMatchObject({ name: "dynamic-skills", source: "./dynamic-skills", description: expect.any(String) });
    const manifest = await json(path.join(CLAUDE, "dynamic-skills/.claude-plugin/plugin.json"));
    expect(manifest).toMatchObject({ name: "dynamic-skills", version: pkg.version, description: expect.any(String) });
    // Only documented top-level keys (unknown keys are stripped with a warning by Claude Code).
    const allowed = ["name", "displayName", "version", "description", "author", "homepage", "repository", "license", "keywords"];
    expect(Object.keys(manifest).every((k) => allowed.includes(k))).toBe(true);
  });

  it("Codex marketplace and portable plugin manifest have the required fields", async () => {
    const pkg = await json(path.join(ROOT, "package.json"));
    const market = await json(path.join(CODEX, ".agents/plugins/marketplace.json"));
    expect(market.name).toBe("dynamic-skills-local");
    const plugins = market.plugins as Array<Record<string, unknown>>;
    expect(plugins[0]).toEqual({
      name: "dynamic-skills",
      source: { source: "local", path: "./dynamic-skills" },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Productivity",
    });
    const manifest = await json(path.join(CODEX, "dynamic-skills/plugin.json"));
    expect(manifest).toMatchObject({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "dynamic-skills",
      version: pkg.version,
      description: expect.any(String),
    });
    expect(String(manifest.name)).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });

  it("Codex openai.yaml declares interface and policy fields", async () => {
    const y = parseYaml(await readFile(path.join(CODEX, "dynamic-skills/skills/dynamic-skill-bootstrap/agents/openai.yaml"), "utf8")) as {
      interface: Record<string, unknown>;
      policy: Record<string, unknown>;
    };
    expect(y.interface).toMatchObject({ display_name: expect.any(String), short_description: expect.any(String), default_prompt: expect.stringContaining("$dynamic-skill-bootstrap") });
    expect(y.policy).toEqual({ allow_implicit_invocation: true });
  });
});

describe("packaged skills", () => {
  it("bootstrap copies stay byte-identical to skills/dynamic-skill-bootstrap/SKILL.md", async () => {
    const source = await readFile(BOOTSTRAP);
    for (const p of [
      path.join(CLAUDE, "dynamic-skills/skills/dynamic-skill-bootstrap/SKILL.md"),
      path.join(CODEX, "dynamic-skills/skills/dynamic-skill-bootstrap/SKILL.md"),
    ]) {
      expect((await readFile(p)).equals(source), `${p} differs from the bootstrap; copy it again`).toBe(true);
    }
  });

  it("generate-skill is an explicit-only command skill that forces generation", async () => {
    const md = await readFile(path.join(CLAUDE, "dynamic-skills/skills/generate-skill/SKILL.md"), "utf8");
    const parsed = parseSkillMd(md);
    expect(parsed?.frontmatter).toMatchObject({ name: "generate-skill", "disable-model-invocation": true, "argument-hint": expect.any(String) });
    expect(parsed?.body).toContain("$ARGUMENTS");
    expect(parsed?.body).toContain("--force-generate");
    expect(parsed?.body).toContain("dynamic-skill-bootstrap");
  });
});

describe("Claude Code bin/dynamic-skills launcher", () => {
  const LAUNCHER = path.join(CLAUDE, "dynamic-skills/bin/dynamic-skills");

  async function script(dir: string, name: string, body: string): Promise<void> {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, name), `#!/bin/sh\n${body}\n`);
    await chmod(path.join(dir, name), 0o755);
  }

  async function setup() {
    const root = await tmpDir("ds-launcher-");
    const pluginBin = path.join(root, "plugin/bin");
    await mkdir(pluginBin, { recursive: true });
    await copyFile(LAUNCHER, path.join(pluginBin, "dynamic-skills"));
    await chmod(path.join(pluginBin, "dynamic-skills"), 0o755);
    const npxDir = path.join(root, "npx");
    await script(npxDir, "npx", 'echo "npx $*"');
    return { root, pluginBin, npxDir };
  }

  async function launch(pluginBin: string, pathDirs: string[], extraEnv: Record<string, string> = {}) {
    return run(path.join(pluginBin, "dynamic-skills"), ["run", "start"], { env: { PATH: [...pathDirs, "/usr/bin", "/bin"].join(":"), ...extraEnv } });
  }

  it("is executable and valid POSIX sh", async () => {
    expect((await stat(LAUNCHER)).mode & 0o111).toBe(0o111);
    await run("sh", ["-n", LAUNCHER]);
  });

  it("prefers a real dynamic-skills elsewhere on PATH", async () => {
    const { root, pluginBin, npxDir } = await setup();
    const real = path.join(root, "real");
    await script(real, "dynamic-skills", 'echo "real $*"');
    expect((await launch(pluginBin, [pluginBin, real, npxDir])).stdout.trim()).toBe("real run start");
  });

  it("falls back to npx, skipping itself and other launcher copies (no recursion)", async () => {
    const { root, pluginBin, npxDir } = await setup();
    const otherCopy = path.join(root, "other-plugin/bin");
    await mkdir(otherCopy, { recursive: true });
    await copyFile(LAUNCHER, path.join(otherCopy, "dynamic-skills"));
    await chmod(path.join(otherCopy, "dynamic-skills"), 0o755);
    expect((await launch(pluginBin, [pluginBin, otherCopy, npxDir])).stdout.trim()).toBe("npx --yes dynamic-skills run start");
  });

  it("fails fast when re-entered", async () => {
    const { pluginBin, npxDir } = await setup();
    await expect(launch(pluginBin, [pluginBin, npxDir], { DYNAMIC_SKILLS_PLUGIN_WRAPPER: "1" })).rejects.toMatchObject({ code: 127 });
  });
});
