import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { LiveSkillsFile, liveSkillEntryFrom, liveSkillsPath } from "../../src/activation/index.js";
import { liveSkillsFileFor } from "../../plugins/opencode/dynskills.js";
import { skillMd, tmpDir } from "../storage/helpers.js";

describe("live-skill file", () => {
  it("lives under the self-ignoring runtime root at the path the OpenCode plugin watches", async () => {
    const root = await tmpDir();
    expect(liveSkillsPath(root, "opencode")).toBe(path.join(root, ".dynamic-skills-runtime/live-skills/opencode.json"));
    expect(liveSkillsFileFor(root)).toBe(liveSkillsPath(root, "opencode"));
  });

  it("builds entries with the SKILL.md body (no frontmatter) and an absolute SKILL.md path", () => {
    const e = liveSkillEntryFrom({ name: "my-skill", skillId: "my-skill@abc", artifactHash: "abc", skillMd: skillMd("my-skill", "Body text"), installedPath: "/x/.opencode/skills/my-skill" });
    expect(e).toMatchObject({ id: "my-skill", name: "my-skill", description: "Use when working on my-skill.", path: "/x/.opencode/skills/my-skill/SKILL.md", skillId: "my-skill@abc" });
    expect(e?.content).toBe("\n# my-skill\n\nBody text\n");
    expect(e?.content).not.toContain("---");
    expect(liveSkillEntryFrom({ name: "x", skillId: "x", artifactHash: "h", skillMd: "no frontmatter", installedPath: "/x" })).toBeUndefined();
  });

  it("upserts and removes atomically, serialising concurrent writers", async () => {
    const root = await tmpDir();
    const file = LiveSkillsFile.for(root, "opencode");
    expect(await file.list()).toEqual([]);
    expect(await file.remove("nothing")).toBe(0);
    const entry = (name: string, content = "c") => ({ id: name, name, path: `/abs/${name}/SKILL.md`, content, skillId: `${name}@1`, artifactHash: "1", updatedAt: "t" });
    await Promise.all(["a-skill", "b-skill", "c-skill"].map((n) => file.upsert(entry(n))));
    expect((await file.list()).map((s) => s.id)).toEqual(["a-skill", "b-skill", "c-skill"]);
    await file.upsert(entry("b-skill", "v2"));
    expect((await file.list()).find((s) => s.id === "b-skill")?.content).toBe("v2");
    expect(await file.remove("a-skill@1")).toBe(1);
    expect(await file.remove("b-skill", (e) => e.path.startsWith("/elsewhere"))).toBe(0);
    expect(await file.remove("b-skill")).toBe(1);
    expect((await file.list()).map((s) => s.id)).toEqual(["c-skill"]);
    expect(await readFile(path.join(root, ".dynamic-skills-runtime/.gitignore"), "utf8")).toBe("*\n");
    expect(JSON.parse(await readFile(file.file, "utf8"))).toMatchObject({ version: 1 });
  });
});
