import { describe, it, expect } from "vitest";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installBootstrap, installNativeIntegration, nativeMarketplaceDir, opencodePluginsDir } from "../../src/adapter-sdk/index.js";
import type { NativeIntegrationAction } from "../../src/adapter-sdk/index.js";
import { ClaudeCodeAdapter, CodexAdapter } from "../../src/adapters/index.js";
import { hashSkillFiles } from "../../src/core/index.js";
import { readSkillDir } from "../../src/storage/index.js";
import { makeSkill, tmpDir } from "../storage/helpers.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BOOTSTRAP_DIR = path.join(ROOT, "skills/dynamic-skill-bootstrap");

async function dirs() {
  return { projectRoot: await tmpDir("ds-native-proj-"), homeDir: await tmpDir("ds-native-home-") };
}

const files = (actions: NativeIntegrationAction[]) => actions.filter((a) => a.kind === "file");
const instructions = (actions: NativeIntegrationAction[]) => actions.filter((a) => a.kind === "instruction");

describe("installNativeIntegration: Claude Code", () => {
  it("copies the marketplace (project scope) and returns the exact commands", async () => {
    const { projectRoot, homeDir } = await dirs();
    const r = await installNativeIntegration({ harness: "claude", scope: "project", projectRoot, homeDir });
    const dir = path.join(projectRoot, ".dynamic-skills/marketplaces/claude");
    expect(nativeMarketplaceDir("claude", "project", { projectRoot, homeDir })).toBe(dir);
    expect(r.harness).toBe("claude");
    const f = files(r.actions);
    expect(f.length).toBeGreaterThanOrEqual(5);
    expect(f.every((a) => a.status === "created" && a.path?.startsWith(dir))).toBe(true);
    expect(await readFile(path.join(dir, "dynskills/skills/dynamic-skill-bootstrap/SKILL.md"))).toEqual(await readFile(path.join(BOOTSTRAP_DIR, "SKILL.md")));
    expect((await stat(path.join(dir, "dynskills/bin/dynskills"))).mode & 0o111).toBe(0o111);
    const cmds = instructions(r.actions).map((a) => a.detail);
    expect(cmds.join("\n")).toContain(`claude plugin marketplace add ${dir}`);
    expect(cmds.join("\n")).toContain("claude plugin install dynskills@dynskills-local --scope project");
    expect(instructions(r.actions).every((a) => a.status === "created")).toBe(true);

    const again = await installNativeIntegration({ harness: "claude", scope: "project", projectRoot, homeDir });
    expect(again.actions.every((a) => a.status === "unchanged")).toBe(true);
  });

  it("uses the home directory and --scope user for personal scope", async () => {
    const { projectRoot, homeDir } = await dirs();
    const r = await installNativeIntegration({ harness: "claude", scope: "personal", projectRoot, homeDir });
    const dir = path.join(homeDir, ".dynamic-skills/marketplaces/claude");
    expect(files(r.actions).every((a) => a.path?.startsWith(dir))).toBe(true);
    expect(instructions(r.actions).map((a) => a.detail).join("\n")).toContain("--scope user");
  });

  it("reports a user-edited file as conflict, leaves it, and replaces it only with force", async () => {
    const { projectRoot, homeDir } = await dirs();
    await installNativeIntegration({ harness: "claude", scope: "project", projectRoot, homeDir });
    const edited = path.join(projectRoot, ".dynamic-skills/marketplaces/claude/dynskills/.claude-plugin/plugin.json");
    await writeFile(edited, '{"name":"mine"}\n');
    const r = await installNativeIntegration({ harness: "claude", scope: "project", projectRoot, homeDir });
    expect(r.actions.find((a) => a.path === edited)?.status).toBe("conflict");
    expect(instructions(r.actions).slice(0, 2).every((a) => a.status === "conflict")).toBe(true);
    expect(await readFile(edited, "utf8")).toBe('{"name":"mine"}\n');
    const forced = await installNativeIntegration({ harness: "claude", scope: "project", projectRoot, homeDir, force: true });
    expect(forced.actions.find((a) => a.path === edited)?.status).toBe("updated");
    expect(JSON.parse(await readFile(edited, "utf8"))).toMatchObject({ name: "dynskills" });
  });

  it("reports a pre-existing differing file it never wrote as conflict", async () => {
    const { projectRoot, homeDir } = await dirs();
    const foreign = path.join(homeDir, ".dynamic-skills/marketplaces/claude/.claude-plugin/marketplace.json");
    await mkdir(path.dirname(foreign), { recursive: true });
    await writeFile(foreign, "{}\n");
    const r = await installNativeIntegration({ harness: "claude", scope: "personal", projectRoot, homeDir });
    expect(r.actions.find((a) => a.path === foreign)?.status).toBe("conflict");
    expect(await readFile(foreign, "utf8")).toBe("{}\n");
  });
});

describe("installNativeIntegration: Codex", () => {
  it("copies the marketplace and returns marketplace add + /plugins instructions", async () => {
    const { projectRoot, homeDir } = await dirs();
    const r = await installNativeIntegration({ harness: "codex", scope: "personal", projectRoot, homeDir });
    const dir = path.join(homeDir, ".dynamic-skills/marketplaces/codex");
    expect(files(r.actions).every((a) => a.status === "created" && a.path?.startsWith(dir))).toBe(true);
    expect(JSON.parse(await readFile(path.join(dir, ".agents/plugins/marketplace.json"), "utf8"))).toMatchObject({ name: "dynskills-local" });
    expect(await readFile(path.join(dir, "dynskills/plugin.json"), "utf8")).toContain("agent-plugins.org");
    expect(await readFile(path.join(dir, "dynskills/skills/dynamic-skill-bootstrap/agents/openai.yaml"), "utf8")).toContain("allow_implicit_invocation");
    const text = instructions(r.actions).map((a) => a.detail).join("\n");
    expect(text).toContain(`codex plugin marketplace add ${dir}`);
    expect(text).toContain("/plugins");
    expect((await installNativeIntegration({ harness: "codex", scope: "personal", projectRoot, homeDir })).actions.every((a) => a.status === "unchanged")).toBe(true);

    const edited = path.join(dir, "dynskills/plugin.json");
    await writeFile(edited, "{}\n");
    const conflict = await installNativeIntegration({ harness: "codex", scope: "personal", projectRoot, homeDir });
    expect(conflict.actions.find((a) => a.path === edited)?.status).toBe("conflict");
    expect(await readFile(edited, "utf8")).toBe("{}\n");
  });

  it("quotes paths with spaces in commands", async () => {
    const homeDir = path.join(await tmpDir(), "home with space");
    const r = await installNativeIntegration({ harness: "codex", scope: "personal", projectRoot: await tmpDir(), homeDir });
    expect(instructions(r.actions)[0]?.detail).toContain(`codex plugin marketplace add '${path.join(homeDir, ".dynamic-skills/marketplaces/codex")}'`);
  });
});

describe("installNativeIntegration: OpenCode", () => {
  const SOURCE = path.join(ROOT, "plugins/opencode/dynskills.js");

  it("copies the plugin into .opencode/plugins (project) and ~/.config/opencode/plugins (personal)", async () => {
    const { projectRoot, homeDir } = await dirs();
    const r = await installNativeIntegration({ harness: "opencode", scope: "project", projectRoot, homeDir });
    const dest = path.join(projectRoot, ".opencode/plugins/dynskills.js");
    expect(opencodePluginsDir("project", { projectRoot, homeDir })).toBe(path.dirname(dest));
    expect(files(r.actions)).toEqual([expect.objectContaining({ path: dest, status: "created" })]);
    expect(await readFile(dest)).toEqual(await readFile(SOURCE));
    expect(instructions(r.actions)[0]?.detail).toMatch(/new OpenCode session/);
    expect((await installNativeIntegration({ harness: "opencode", scope: "project", projectRoot, homeDir })).actions.every((a) => a.status === "unchanged")).toBe(true);

    const personal = await installNativeIntegration({ harness: "opencode", scope: "personal", projectRoot, homeDir });
    expect(files(personal.actions)[0]?.path).toBe(path.join(homeDir, ".config/opencode/plugins/dynskills.js"));
  });

  it("refuses to overwrite a differing file not written by Dynamic Skills unless forced; updates its own copies", async () => {
    const { projectRoot, homeDir } = await dirs();
    const dest = path.join(projectRoot, ".opencode/plugins/dynskills.js");
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, "export default {}\n");
    const r = await installNativeIntegration({ harness: "opencode", scope: "project", projectRoot, homeDir });
    expect(files(r.actions)[0]?.status).toBe("conflict");
    expect(instructions(r.actions)[0]?.status).toBe("conflict");
    expect(await readFile(dest, "utf8")).toBe("export default {}\n");
    expect(files((await installNativeIntegration({ harness: "opencode", scope: "project", projectRoot, homeDir, force: true })).actions)[0]?.status).toBe("updated");

    // An older Dynamic Skills copy (carries the marker) is updated without force.
    await writeFile(dest, "// @dynskills-opencode-plugin v0\nexport default {}\n");
    expect(files((await installNativeIntegration({ harness: "opencode", scope: "project", projectRoot, homeDir })).actions)[0]?.status).toBe("updated");
    expect(await readFile(dest)).toEqual(await readFile(SOURCE));
  });
});

describe("Codex bootstrap extras (agents/openai.yaml)", () => {
  it("writes openai.yaml only when requested and keeps the canonical hash unchanged", async () => {
    const { projectRoot, homeDir } = await dirs();
    const adapter = new CodexAdapter({ projectRoot, homeDir, env: { PATH: "" } });
    const target = path.join(projectRoot, ".agents/skills/dynamic-skill-bootstrap");
    const sourceHash = hashSkillFiles(await readSkillDir(BOOTSTRAP_DIR));
    const canonicalHash = async () => hashSkillFiles((await readSkillDir(target)).filter((f) => f.path !== "agents/openai.yaml"));

    expect((await installBootstrap({ adapter, scope: "project", sourceDir: BOOTSTRAP_DIR })).status).toBe("created");
    await expect(stat(path.join(target, "agents"))).rejects.toThrow();
    expect((await installBootstrap({ adapter, scope: "project", sourceDir: BOOTSTRAP_DIR, harnessExtras: true })).status).toBe("updated");
    const yaml = await readFile(path.join(target, "agents/openai.yaml"), "utf8");
    expect(yaml).toBe(await readFile(path.join(ROOT, "plugins/codex/dynskills/skills/dynamic-skill-bootstrap/agents/openai.yaml"), "utf8"));
    expect(await canonicalHash()).toBe(sourceHash);
    expect((await installBootstrap({ adapter, scope: "project", sourceDir: BOOTSTRAP_DIR, harnessExtras: true })).status).toBe("unchanged");
    expect((await installBootstrap({ adapter, scope: "project", sourceDir: BOOTSTRAP_DIR })).status).toBe("unchanged");

    const fresh = new CodexAdapter({ projectRoot, homeDir, env: { PATH: "" } });
    expect((await installBootstrap({ adapter: fresh, scope: "personal", sourceDir: BOOTSTRAP_DIR, harnessExtras: true })).status).toBe("created");
    expect(await readFile(path.join(homeDir, ".agents/skills/dynamic-skill-bootstrap/agents/openai.yaml"), "utf8")).toBe(yaml);
  });

  it("adds no extras for other harnesses or for generated skills (§10.5)", async () => {
    const { projectRoot, homeDir } = await dirs();
    const claude = new ClaudeCodeAdapter({ projectRoot, homeDir, env: { PATH: "" } });
    await installBootstrap({ adapter: claude, scope: "project", sourceDir: BOOTSTRAP_DIR, harnessExtras: true });
    await expect(stat(path.join(projectRoot, ".claude/skills/dynamic-skill-bootstrap/agents"))).rejects.toThrow();

    const codex = new CodexAdapter({ projectRoot, homeDir, env: { PATH: "" } });
    expect(await codex.harnessExtraFiles("some-generated-skill")).toEqual([]);
    const skill = makeSkill("some-generated-skill");
    await codex.saveSkill(skill, "project");
    expect(hashSkillFiles(await readSkillDir(path.join(projectRoot, ".agents/skills/some-generated-skill")))).toBe(skill.artifactHash);
  });
});
