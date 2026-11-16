import { describe, it, expect } from "vitest";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ACTIVATION_PREFERENCE,
  DirectorySkillActivator,
  InstallRegistry,
  selectActivationCapability,
  verifyActivation,
} from "../../src/activation/index.js";
import { DynamicSkillsError } from "../../src/core/index.js";
import { readSkillDir } from "../../src/storage/index.js";
import { makeSkill, skillMd, tmpDir } from "../storage/helpers.js";

describe("activation preference", () => {
  it("follows §9.2 order", () => {
    expect(ACTIVATION_PREFERENCE).toEqual(["live_skill_registration", "watched_directory", "current_turn_instruction_injection", "explicit_reload"]);
    expect(selectActivationCapability(["explicit_reload", "watched_directory"])).toBe("watched_directory");
    expect(selectActivationCapability(["explicit_reload", "current_turn_instruction_injection"])).toBe("current_turn_instruction_injection");
    expect(selectActivationCapability(["watched_directory", "live_skill_registration"])).toBe("live_skill_registration");
    expect(() => selectActivationCapability([])).toThrow(DynamicSkillsError);
  });
});

describe("verifyActivation", () => {
  it("checks existence, SKILL.md and hash", async () => {
    const root = await tmpDir();
    const skill = makeSkill("x-skill");
    const dir = path.join(root, "x-skill");
    expect((await verifyActivation({ installedPath: dir, expectedHash: skill.artifactHash, readFiles: readSkillDir })).ok).toBe(false);
    await mkdir(dir);
    expect((await verifyActivation({ installedPath: dir, expectedHash: skill.artifactHash, readFiles: readSkillDir })).reason).toMatch(/SKILL.md/);
    await writeFile(path.join(dir, "SKILL.md"), skill.files[0]!.content);
    expect(await verifyActivation({ installedPath: dir, expectedHash: skill.artifactHash, readFiles: readSkillDir })).toEqual({ ok: true });
    await writeFile(path.join(dir, "SKILL.md"), "tampered");
    expect((await verifyActivation({ installedPath: dir, expectedHash: skill.artifactHash, readFiles: readSkillDir })).reason).toMatch(/does not match/);
  });
});

describe("DirectorySkillActivator", () => {
  async function setup() {
    const root = await tmpDir();
    const skillsDir = path.join(root, ".claude/skills");
    const registryPath = path.join(root, ".dynamic-skills-runtime/installs/claude.json");
    const activator = new DirectorySkillActivator({
      harness: "claude",
      skillsDir,
      capabilities: ["watched_directory", "current_turn_instruction_injection", "explicit_reload"],
      reloadHint: (n) => `run /reload-skills for ${n}`,
      invocationHint: (n) => `/${n}`,
      registryPath,
    });
    return { root, skillsDir, registryPath, activator };
  }

  it("installs, verifies and returns instructions; requiresReload only when the dir is new", async () => {
    const { skillsDir, registryPath, activator } = await setup();
    const skill = makeSkill("first-skill");
    const r = await activator.activate(skill);
    expect(r).toMatchObject({ success: true, capability: "watched_directory", requiresReload: true, invocationHint: "/first-skill", installedPath: path.join(skillsDir, "first-skill") });
    expect(r.instructions).toBe(skill.files[0]!.content);
    expect(r.message).toMatch(/reload-skills/);
    expect((await new InstallRegistry(registryPath).list()).map((e) => e.name)).toEqual(["first-skill"]);
    const r2 = await activator.activate(makeSkill("second-skill"));
    expect(r2.requiresReload).toBe(false);
    // Revision of an ephemeral install replaces it.
    const revised = makeSkill("first-skill", "revised");
    expect((await activator.activate(revised)).success).toBe(true);
    expect(await readFile(path.join(skillsDir, "first-skill/SKILL.md"), "utf8")).toContain("revised");
  });

  it("never overwrites a user's skill and never claims success on hash mismatch", async () => {
    const { skillsDir, activator } = await setup();
    await mkdir(path.join(skillsDir, "mine"), { recursive: true });
    await writeFile(path.join(skillsDir, "mine/SKILL.md"), skillMd("mine", "user content", { marker: false }));
    const r = await activator.activate(makeSkill("mine"));
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/not installed by Dynamic Skills/);
    expect(await readFile(path.join(skillsDir, "mine/SKILL.md"), "utf8")).toContain("user content");

    const bad = { ...makeSkill("bad-skill"), artifactHash: "0".repeat(64) };
    expect((await activator.activate(bad)).success).toBe(false);
    await expect(stat(path.join(skillsDir, "bad-skill"))).rejects.toThrow();
  });

  it("deactivate removes only its own ephemeral installs", async () => {
    const { skillsDir, registryPath, activator } = await setup();
    const skill = makeSkill("temp-skill");
    await activator.activate(skill);
    await mkdir(path.join(skillsDir, "user-skill"), { recursive: true });
    await writeFile(path.join(skillsDir, "user-skill/SKILL.md"), skillMd("user-skill", "u", { marker: false }));
    await activator.deactivate("user-skill@abc");
    await activator.deactivate(skill.skillId);
    await expect(stat(path.join(skillsDir, "temp-skill"))).rejects.toThrow();
    expect(await stat(path.join(skillsDir, "user-skill"))).toBeTruthy();
    expect(await new InstallRegistry(registryPath).list()).toEqual([]);
  });

  it("leaves a user-edited ephemeral install in place on deactivate", async () => {
    const { skillsDir, activator } = await setup();
    const skill = makeSkill("edited-skill");
    await activator.activate(skill);
    await writeFile(path.join(skillsDir, "edited-skill/notes.md"), "user notes");
    await activator.deactivate(skill.skillId);
    expect(await stat(path.join(skillsDir, "edited-skill/notes.md"))).toBeTruthy();
  });
});
