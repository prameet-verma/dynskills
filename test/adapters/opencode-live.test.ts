import { describe, it, expect } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { installNativeIntegration } from "../../src/adapter-sdk/index.js";
import { LiveSkillsFile } from "../../src/activation/index.js";
import { OpenCodeAdapter } from "../../src/adapters/index.js";
import { makeSkill, tmpDir } from "../storage/helpers.js";

async function setup() {
  const projectRoot = await tmpDir("ds-oc-proj-");
  const homeDir = await tmpDir("ds-oc-home-");
  const adapter = new OpenCodeAdapter({ projectRoot, homeDir, env: { PATH: "" }, sessionId: "ses_test" });
  return { projectRoot, homeDir, adapter, live: LiveSkillsFile.for(projectRoot, "opencode") };
}

describe("OpenCode adapter: capabilities", () => {
  it("does not advertise live registration without the plugin", async () => {
    const { adapter } = await setup();
    const caps = await adapter.getCapabilities();
    expect(caps.activation).toEqual(["watched_directory", "current_turn_instruction_injection"]);
    expect(caps.pluginIntegration).toBe(false);
  });

  it.each(["project", "personal"] as const)("puts live_skill_registration first when the plugin is installed (%s)", async (scope) => {
    const { adapter, projectRoot, homeDir } = await setup();
    await installNativeIntegration({ harness: "opencode", scope, projectRoot, homeDir });
    const caps = await adapter.getCapabilities();
    expect(caps.activation).toEqual(["live_skill_registration", "watched_directory", "current_turn_instruction_injection"]);
    expect(caps.pluginIntegration).toBe(true);
  });

  it("ignores an unrelated file named dynskills.js", async () => {
    const { adapter, projectRoot } = await setup();
    await mkdir(path.join(projectRoot, ".opencode/plugins"), { recursive: true });
    await writeFile(path.join(projectRoot, ".opencode/plugins/dynskills.js"), "export default {}\n");
    expect((await adapter.getCapabilities()).activation[0]).toBe("watched_directory");
  });
});

describe("OpenCode adapter: live-skill file on activation", () => {
  it("upserts on activation and removes on deactivation (without the plugin: watched_directory)", async () => {
    const { adapter, projectRoot, live } = await setup();
    const skill = makeSkill("oc-skill", "Do it the OpenCode way");
    const r = await adapter.loadSkillForSession(skill);
    expect(r).toMatchObject({ success: true, capability: "watched_directory", requiresReload: true, instructions: skill.files[0]!.content });
    const entries = await live.list();
    expect(entries).toEqual([
      expect.objectContaining({
        id: "oc-skill",
        name: "oc-skill",
        description: "Use when working on oc-skill.",
        path: path.join(projectRoot, ".opencode/skills/oc-skill/SKILL.md"),
        skillId: skill.skillId,
        artifactHash: skill.artifactHash,
      }),
    ]);
    expect(entries[0]?.content).toBe("\n# oc-skill\n\nDo it the OpenCode way\n");

    // Revision replaces the entry in place.
    const revised = makeSkill("oc-skill", "revised");
    expect((await adapter.loadSkillForSession(revised)).success).toBe(true);
    expect((await live.list()).map((e) => [e.id, e.skillId])).toEqual([["oc-skill", revised.skillId]]);

    await adapter.removeSkill(revised.skillId, "ephemeral");
    expect(await live.list()).toEqual([]);
  });

  it("reports live_skill_registration with the plugin, still returning instructions and never claiming more", async () => {
    const { adapter, projectRoot, homeDir, live } = await setup();
    await installNativeIntegration({ harness: "opencode", scope: "project", projectRoot, homeDir });
    const skill = makeSkill("plugin-skill");
    const r = await adapter.loadSkillForSession(skill);
    expect(r).toMatchObject({ success: true, capability: "live_skill_registration", requiresReload: false, artifactHash: skill.artifactHash });
    expect(r.instructions).toBe(skill.files[0]!.content);
    expect(r.message).toMatch(/if the plugin is loaded in this session/);
    expect(r.message).toMatch(/full instructions are included/);
    expect(r.message).toContain(path.join(projectRoot, ".opencode/plugins/dynskills.js"));
    expect((await live.list()).map((e) => e.id)).toEqual(["plugin-skill"]);
  });

  it("does not write a live entry when activation fails", async () => {
    const { adapter, projectRoot, live } = await setup();
    await mkdir(path.join(projectRoot, ".opencode/skills/taken"), { recursive: true });
    await writeFile(path.join(projectRoot, ".opencode/skills/taken/SKILL.md"), "---\nname: taken\ndescription: user skill\n---\nmine\n");
    expect((await adapter.loadSkillForSession(makeSkill("taken"))).success).toBe(false);
    expect(await live.list()).toEqual([]);
    await expect(readFile(live.file)).rejects.toThrow();
  });

  it("removing a persisted copy only drops live entries that point into that scope", async () => {
    const { adapter, live } = await setup();
    const skill = makeSkill("scoped-skill");
    await adapter.loadSkillForSession(skill);
    await adapter.saveSkill(skill, "personal");
    await adapter.removeSkill(skill.skillId, "personal");
    expect((await live.list()).map((e) => e.id)).toEqual(["scoped-skill"]);
    await adapter.removeSkill(skill.skillId, "ephemeral");
    expect(await live.list()).toEqual([]);
  });
});
