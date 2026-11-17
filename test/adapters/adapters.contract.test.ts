import { describe, it, expect } from "vitest";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ClarificationRequest, HarnessId } from "../../src/contracts/index.js";
import { DynamicSkillsError } from "../../src/core/index.js";
import { ClaudeCodeAdapter, CodexAdapter, OpenCodeAdapter, createAdapter } from "../../src/adapters/index.js";
import type { BaseHarnessAdapter } from "../../src/adapter-sdk/index.js";
import { makeSkill, skillMd, tmpDir } from "../storage/helpers.js";

interface Case {
  id: HarnessId;
  cls: typeof ClaudeCodeAdapter | typeof CodexAdapter | typeof OpenCodeAdapter;
  projectRel: string;
  personalRel: string;
  hasReload: boolean;
  reloadText: RegExp;
}

const CASES: Case[] = [
  { id: "claude", cls: ClaudeCodeAdapter, projectRel: ".claude/skills", personalRel: ".claude/skills", hasReload: true, reloadText: /\/reload-skills/ },
  { id: "codex", cls: CodexAdapter, projectRel: ".agents/skills", personalRel: ".agents/skills", hasReload: true, reloadText: /restart/i },
  { id: "opencode", cls: OpenCodeAdapter, projectRel: ".opencode/skills", personalRel: ".config/opencode/skills", hasReload: false, reloadText: /restart/i },
];

const REQUEST: ClarificationRequest = {
  runId: "run_1",
  round: 1,
  maximumRounds: 3,
  questions: [{ id: "q1", question: "Which DB?", reason: "ambiguous", required: true }],
  context: "ctx",
};

async function writeUserSkill(dir: string, name: string, body = "user body", marker = false): Promise<void> {
  await mkdir(path.join(dir, name), { recursive: true });
  await writeFile(path.join(dir, name, "SKILL.md"), skillMd(name, body, { marker }));
}

describe.each(CASES)("HarnessAdapter contract: $id", (c) => {
  async function setup(extra: { askUser?: (r: ClarificationRequest) => Promise<never> | Promise<import("../../src/contracts/index.js").ClarificationResponse> } = {}) {
    const projectRoot = await tmpDir(`ds-${c.id}-proj-`);
    const homeDir = await tmpDir(`ds-${c.id}-home-`);
    const binDir = await tmpDir(`ds-${c.id}-bin-`);
    const adapter: BaseHarnessAdapter = createAdapter(c.id, {
      projectRoot,
      homeDir,
      sessionId: "ses_test",
      env: { PATH: binDir },
      workspace: { repositoryId: "repo_test" },
      ...(extra.askUser ? { askUser: extra.askUser } : {}),
    });
    return { projectRoot, homeDir, binDir, adapter, projectDir: path.join(projectRoot, c.projectRel), personalDir: path.join(homeDir, c.personalRel) };
  }

  it("has the right id, class and skill directories", async () => {
    const { adapter, projectDir, personalDir } = await setup();
    expect(adapter).toBeInstanceOf(c.cls);
    expect(adapter.id).toBe(c.id);
    expect(adapter.skillsDirFor("project")).toBe(projectDir);
    expect(adapter.skillsDirFor("personal")).toBe(personalDir);
  });

  it("detects capabilities at runtime (installed via PATH)", async () => {
    const { adapter, binDir } = await setup();
    const caps = await adapter.getCapabilities();
    expect(caps).toMatchObject({ harness: c.id, installed: false });
    expect(caps.activation).toContain("watched_directory");
    expect(caps.activation).toContain("current_turn_instruction_injection");
    expect(caps.activation).not.toContain("live_skill_registration");
    expect(caps.activation.includes("explicit_reload")).toBe(c.hasReload);
    const bin = path.join(binDir, c.id === "claude" ? "claude" : c.id);
    await writeFile(bin, "#!/bin/sh\n");
    await chmod(bin, 0o755);
    await adapter.initialize();
    expect((await adapter.getCapabilities()).installed).toBe(true);
  });

  it("returns workspace context with injected overrides", async () => {
    const { adapter, projectRoot } = await setup();
    expect(await adapter.getWorkspaceContext()).toMatchObject({ root: projectRoot, workingDirectory: projectRoot, repositoryId: "repo_test", sessionId: "ses_test" });
  });

  it("discovers existing project and personal skills, skipping malformed ones", async () => {
    const { adapter, projectDir, personalDir } = await setup();
    expect(await adapter.getExistingSkills()).toEqual([]);
    await writeUserSkill(projectDir, "proj-skill");
    await writeUserSkill(personalDir, "home-skill");
    await mkdir(path.join(projectDir, "broken"), { recursive: true });
    await writeFile(path.join(projectDir, "broken/SKILL.md"), "no frontmatter here");
    await mkdir(path.join(projectDir, "empty"), { recursive: true });
    const items = await adapter.getExistingSkills();
    expect(items.map((i) => [i.name, i.scope, i.harness])).toEqual([
      ["home-skill", "personal", c.id],
      ["proj-skill", "project", c.id],
    ]);
    expect(items[1]?.path).toBe(path.join(projectDir, "proj-skill"));
  });

  it("installs skills into project and personal scope (saveSkill)", async () => {
    const { adapter, projectDir, personalDir } = await setup();
    const skill = makeSkill("persist-me");
    await adapter.saveSkill(skill, "project");
    await adapter.saveSkill(skill, "personal");
    for (const d of [projectDir, personalDir]) {
      expect(await readFile(path.join(d, "persist-me/SKILL.md"), "utf8")).toBe(skill.files[0]!.content);
    }
    // Updating our own install is allowed.
    const v2 = makeSkill("persist-me", "v2");
    await adapter.saveSkill(v2, "project");
    expect(await readFile(path.join(projectDir, "persist-me/SKILL.md"), "utf8")).toContain("v2");
    expect((await adapter.getExistingSkills()).map((i) => i.scope)).toEqual(["personal", "project"]);
  });

  it("activates a skill at runtime: files exist, hash verified, instructions returned, reload when dir is new", async () => {
    const { adapter, projectDir, projectRoot } = await setup();
    const skill = makeSkill("runtime-skill", "Do the thing", [{ path: "references/notes.md", content: "notes\n" }]);
    const r = await adapter.loadSkillForSession(skill);
    expect(r.success).toBe(true);
    expect(r.capability).toBe("watched_directory");
    expect(r.skillId).toBe(skill.skillId);
    expect(r.artifactHash).toBe(skill.artifactHash);
    expect(r.installedPath).toBe(path.join(projectDir, "runtime-skill"));
    expect(r.instructions).toBe(skill.files[0]!.content);
    expect(r.requiresReload).toBe(true);
    expect(r.message).toMatch(c.reloadText);
    expect(r.invocationHint).toContain("runtime-skill");
    expect(await readFile(path.join(projectDir, "runtime-skill/references/notes.md"), "utf8")).toBe("notes\n");
    // The directory was created during this session, so the host is still not watching it.
    const again = await adapter.loadSkillForSession(makeSkill("another-skill"));
    expect(again.requiresReload).toBe(true);
    // A later session watches the directory from its start.
    const nextSession = createAdapter(c.id, {
      projectRoot,
      homeDir: await tmpDir(),
      sessionId: "ses_later",
      env: { PATH: "" },
      workspace: { repositoryId: "repo_test" },
    });
    expect((await nextSession.loadSkillForSession(makeSkill("third-skill"))).requiresReload).toBe(false);
  });

  it("refuses to overwrite a user's same-named skill", async () => {
    const { adapter, projectDir, personalDir } = await setup();
    await writeUserSkill(projectDir, "taken");
    await writeUserSkill(personalDir, "taken");
    const skill = makeSkill("taken");
    const r = await adapter.loadSkillForSession(skill);
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/refusing to overwrite/);
    await expect(adapter.saveSkill(skill, "project")).rejects.toThrow(DynamicSkillsError);
    await expect(adapter.saveSkill(skill, "personal")).rejects.toThrow(/refusing to overwrite/);
    for (const d of [projectDir, personalDir]) expect(await readFile(path.join(d, "taken/SKILL.md"), "utf8")).toContain("user body");
  });

  it("does not replace a persisted skill with an ephemeral activation", async () => {
    const { adapter, projectDir } = await setup();
    await adapter.saveSkill(makeSkill("kept-skill", "persisted v1"), "project");
    const r = await adapter.loadSkillForSession(makeSkill("kept-skill", "ephemeral v2"));
    expect(r.success).toBe(false);
    expect(await readFile(path.join(projectDir, "kept-skill/SKILL.md"), "utf8")).toContain("persisted v1");
    // Activating the identical persisted artifact succeeds without rewriting it.
    expect((await adapter.loadSkillForSession(makeSkill("kept-skill", "persisted v1"))).success).toBe(true);
  });

  it("removes only its own installs", async () => {
    const { adapter, projectDir, personalDir } = await setup();
    const eph = makeSkill("eph-skill");
    await adapter.loadSkillForSession(eph);
    await writeUserSkill(projectDir, "user-owned");
    await adapter.removeSkill(eph.skillId, "ephemeral");
    await expect(stat(path.join(projectDir, "eph-skill"))).rejects.toThrow();

    const saved = makeSkill("saved-skill");
    await adapter.saveSkill(saved, "personal");
    await adapter.removeSkill(saved.skillId, "personal");
    await expect(stat(path.join(personalDir, "saved-skill"))).rejects.toThrow();

    await expect(adapter.removeSkill("user-owned", "project")).rejects.toThrow(DynamicSkillsError);
    await adapter.removeSkill("user-owned", "ephemeral"); // not registered → no-op
    expect(await stat(path.join(projectDir, "user-owned/SKILL.md"))).toBeTruthy();
    await adapter.removeSkill("never-existed", "project"); // idempotent

    // A promoted (ephemeral → project) skill is not removed by ephemeral cleanup.
    const promoted = makeSkill("promoted-skill");
    await adapter.loadSkillForSession(promoted);
    await adapter.saveSkill(promoted, "project");
    await adapter.removeSkill(promoted.skillId, "ephemeral");
    expect(await stat(path.join(projectDir, "promoted-skill/SKILL.md"))).toBeTruthy();
  });

  it("propagates the clarification error without a callback and delegates with one", async () => {
    const { adapter } = await setup();
    try {
      await adapter.askUser(REQUEST);
      expect.fail("askUser should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DynamicSkillsError);
      expect((err as DynamicSkillsError).info).toMatchObject({ category: "clarification", component: "adapter", recoverable: true, runId: "run_1" });
      expect((err as Error).message).toMatch(/native question tool/);
    }
    const answered = await setup({ askUser: async (r) => ({ runId: r.runId, round: r.round, answers: [{ questionId: "q1", answer: "postgres", status: "answered" }] }) });
    expect((await answered.adapter.askUser(REQUEST)).answers[0]?.answer).toBe("postgres");
    const failing = await setup({ askUser: async () => { throw new Error("user cancelled"); } });
    await expect(failing.adapter.askUser(REQUEST)).rejects.toThrow("user cancelled");
  });
});
