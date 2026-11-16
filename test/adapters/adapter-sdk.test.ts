import { describe, it, expect } from "vitest";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { detectHarnesses, installBootstrap, isOnPath, readRepositoryIdentity } from "../../src/adapter-sdk/index.js";
import { ClaudeCodeAdapter, createAdapter } from "../../src/adapters/index.js";
import { DynamicSkillsError } from "../../src/core/index.js";
import { tmpDir } from "../storage/helpers.js";

const BOOTSTRAP = `---
name: dynamic-skill-bootstrap
description: Identify missing task-specific expertise and invoke Dynamic Skills.
metadata:
  dynamic-skills.role: bootstrap
---

# Bootstrap
`;

async function exe(dir: string, name: string): Promise<void> {
  await writeFile(path.join(dir, name), "#!/bin/sh\n");
  await chmod(path.join(dir, name), 0o755);
}

describe("isOnPath", () => {
  it("finds executables on PATH without a shell", async () => {
    const a = await tmpDir();
    const b = await tmpDir();
    await exe(b, "codex");
    await writeFile(path.join(a, "claude"), "not executable");
    const env = { PATH: [a, b].join(path.delimiter) };
    expect(await isOnPath("codex", env)).toBe(true);
    expect(await isOnPath("claude", env)).toBe(false);
    expect(await isOnPath("opencode", env)).toBe(false);
    expect(await isOnPath("../codex", env)).toBe(false);
    expect(await isOnPath("codex", {})).toBe(false);
  });
});

describe("detectHarnesses", () => {
  it("detects by binaries and config dirs in temp dirs", async () => {
    const projectRoot = await tmpDir();
    const homeDir = await tmpDir();
    const bin = await tmpDir();
    expect(await detectHarnesses({ projectRoot, homeDir, env: { PATH: bin } })).toEqual([]);
    await exe(bin, "claude");
    await mkdir(path.join(projectRoot, ".agents"));
    await writeFile(path.join(projectRoot, "opencode.json"), "{}");
    await mkdir(path.join(homeDir, ".config/opencode"), { recursive: true });
    const found = await detectHarnesses({ projectRoot, homeDir, env: { PATH: bin } });
    expect(found.map((f) => f.id)).toEqual(["claude", "codex", "opencode"]);
    expect(found[0]?.reasons).toEqual(["`claude` found on PATH"]);
    expect(found[1]?.reasons.join()).toMatch(/\.agents/);
    expect(found[2]?.reasons).toHaveLength(2);
    await mkdir(path.join(homeDir, ".claude"));
    const again = await detectHarnesses({ projectRoot, homeDir, env: { PATH: bin } });
    expect(again[0]?.reasons).toHaveLength(2);
  });
});

describe("installBootstrap", () => {
  async function setup() {
    const projectRoot = await tmpDir();
    const homeDir = await tmpDir();
    const source = path.join(await tmpDir(), "dynamic-skill-bootstrap");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "SKILL.md"), BOOTSTRAP);
    const adapter = new ClaudeCodeAdapter({ projectRoot, homeDir, env: { PATH: "" } });
    return { projectRoot, homeDir, source, adapter };
  }

  it("creates, reports unchanged, updates marked copies and conflicts on user copies", async () => {
    const { source, adapter, projectRoot, homeDir } = await setup();
    const target = path.join(projectRoot, ".claude/skills/dynamic-skill-bootstrap");
    expect(await installBootstrap({ adapter, scope: "project", sourceDir: source })).toEqual({ path: target, status: "created" });
    expect(await installBootstrap({ adapter, scope: "project", sourceDir: source })).toEqual({ path: target, status: "unchanged" });
    await writeFile(path.join(source, "SKILL.md"), BOOTSTRAP + "\nv2\n");
    expect((await installBootstrap({ adapter, scope: "project", sourceDir: source })).status).toBe("updated");
    expect(await readFile(path.join(target, "SKILL.md"), "utf8")).toContain("v2");

    const personalTarget = path.join(homeDir, ".claude/skills/dynamic-skill-bootstrap");
    await mkdir(personalTarget, { recursive: true });
    await writeFile(path.join(personalTarget, "SKILL.md"), "---\nname: dynamic-skill-bootstrap\ndescription: mine\n---\nuser version\n");
    expect((await installBootstrap({ adapter, scope: "personal", sourceDir: source })).status).toBe("conflict");
    expect(await readFile(path.join(personalTarget, "SKILL.md"), "utf8")).toContain("user version");
    expect((await installBootstrap({ adapter, scope: "personal", sourceDir: source, force: true })).status).toBe("updated");
    expect(await readFile(path.join(personalTarget, "SKILL.md"), "utf8")).toContain("v2");
  });

  it("works with every adapter and rejects a malformed source", async () => {
    const projectRoot = await tmpDir();
    const homeDir = await tmpDir();
    const { source } = await setup();
    for (const id of ["claude", "codex", "opencode"] as const) {
      const adapter = createAdapter(id, { projectRoot, homeDir });
      const r = await installBootstrap({ adapter, scope: "project", sourceDir: source });
      expect(r.status).toBe("created");
      expect(r.path).toBe(path.join(adapter.skillsDirFor("project"), "dynamic-skill-bootstrap"));
    }
    const empty = await tmpDir();
    await expect(installBootstrap({ adapter: createAdapter("claude", { projectRoot, homeDir }), scope: "project", sourceDir: empty })).rejects.toThrow(DynamicSkillsError);
  });
});

describe("readRepositoryIdentity", () => {
  it("derives a stable id from the origin remote and reads HEAD without git", async () => {
    const a = await tmpDir();
    const b = await tmpDir();
    for (const [root, url] of [
      [a, "git@github.com:Acme/Repo.git"],
      [b, "https://github.com/acme/repo"],
    ] as const) {
      await mkdir(path.join(root, ".git/refs/heads"), { recursive: true });
      await writeFile(path.join(root, ".git/config"), `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${url}\n`);
      await writeFile(path.join(root, ".git/HEAD"), "ref: refs/heads/main\n");
      await writeFile(path.join(root, ".git/refs/heads/main"), `${"a".repeat(40)}\n`);
    }
    const ia = await readRepositoryIdentity(a);
    const ib = await readRepositoryIdentity(b);
    expect(ia.repositoryId).toBe(ib.repositoryId);
    expect(ia.revision).toBe("a".repeat(40));
    const plain = await readRepositoryIdentity(await tmpDir());
    expect(plain.repositoryId).toMatch(/^repo_[0-9a-f]{16}$/);
    expect(plain.revision).toBeUndefined();
  });
});
