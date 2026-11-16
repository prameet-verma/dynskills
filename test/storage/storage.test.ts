import { describe, it, expect } from "vitest";
import { mkdir, readFile, readdir, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ArtifactStore,
  bundleRoot,
  ensureRuntimeRoot,
  hasDynamicSkillsMarker,
  parseSkillMd,
  runDir,
  runtimeRoot,
  stagedSkillDir,
} from "../../src/storage/index.js";
import { DynamicSkillsError } from "../../src/core/index.js";
import { makeRecord, makeSkill, skillMd, tmpDir } from "./helpers.js";

describe("storage paths", () => {
  it("builds runtime, run, staged and bundle paths", async () => {
    const root = await tmpDir();
    const home = await tmpDir();
    expect(runtimeRoot(root)).toBe(path.join(root, ".dynamic-skills-runtime"));
    expect(runDir(root, "ses_1", "run_1")).toBe(path.join(root, ".dynamic-skills-runtime/sessions/ses_1/runs/run_1"));
    expect(stagedSkillDir(root, "ses_1", "run_1", "my-skill")).toBe(path.join(root, ".dynamic-skills-runtime/sessions/ses_1/runs/run_1/skills/my-skill"));
    expect(bundleRoot("project", { projectRoot: root })).toBe(path.join(root, ".dynamic-skills/bundles"));
    expect(bundleRoot("personal", { projectRoot: root, homeDir: home })).toBe(path.join(home, ".dynamic-skills/bundles"));
  });

  it("rejects traversal in names and ids", async () => {
    const root = await tmpDir();
    expect(() => stagedSkillDir(root, "ses", "run", "../evil")).toThrow(DynamicSkillsError);
    expect(() => runDir(root, "../ses", "run")).toThrow(DynamicSkillsError);
    expect(() => runDir(root, "ses", "a/b")).toThrow(DynamicSkillsError);
  });

  it("creates a self-ignoring runtime root without touching the user's .gitignore", async () => {
    const root = await tmpDir();
    await writeFile(path.join(root, ".gitignore"), "node_modules\n");
    const rt = await ensureRuntimeRoot(root);
    expect(await readFile(path.join(rt, ".gitignore"), "utf8")).toBe("*\n");
    expect(await readFile(path.join(root, ".gitignore"), "utf8")).toBe("node_modules\n");
    await ensureRuntimeRoot(root); // idempotent
  });
});

describe("skill-md", () => {
  it("parses frontmatter and detects the Dynamic Skills marker", () => {
    expect(parseSkillMd(skillMd("a-skill"))?.frontmatter.name).toBe("a-skill");
    expect(hasDynamicSkillsMarker(skillMd("a-skill"))).toBe(true);
    expect(hasDynamicSkillsMarker(skillMd("a-skill", "x", { marker: false }))).toBe(false);
    expect(hasDynamicSkillsMarker("---\nname: a\ndescription: b\nmetadata:\n  dynamic-skills:\n    role: bootstrap\n---\n")).toBe(true);
    expect(parseSkillMd("no frontmatter")).toBeUndefined();
    expect(parseSkillMd("---\nname: [unclosed\n---\n")).toBeUndefined();
    expect(parseSkillMd("---\nname: a\n---\n")).toBeUndefined(); // missing description
  });
});

describe("ArtifactStore", () => {
  it("stages a skill atomically, reads it back sorted and verifies its hash", async () => {
    const root = await tmpDir();
    const store = new ArtifactStore({ projectRoot: root });
    const skill = makeSkill("api-review", "Body", [{ path: "references/conventions.md", content: "# Conv\n" }]);
    const dir = await store.stageSkill("ses_1", "run_1", skill);
    expect(dir).toBe(stagedSkillDir(root, "ses_1", "run_1", "api-review"));
    const files = await store.readSkillDir(dir);
    expect(files.map((f) => f.path)).toEqual(["SKILL.md", "references/conventions.md"]);
    expect(await store.verifyHash(dir, skill.artifactHash)).toBe(true);
    expect(await store.verifyHash(dir, "0".repeat(64))).toBe(false);
    expect(await store.verifyHash(path.join(root, "nope"), skill.artifactHash)).toBe(false);
    // A revision in the same run replaces the staged copy.
    const revised = makeSkill("api-review", "Revised");
    await store.stageSkill("ses_1", "run_1", revised);
    expect(await store.verifyHash(dir, revised.artifactHash)).toBe(true);
    expect(await readFile(path.join(runtimeRoot(root), ".gitignore"), "utf8")).toBe("*\n");
  });

  it("rejects a skill whose artifactHash does not match its files", async () => {
    const store = new ArtifactStore({ projectRoot: await tmpDir() });
    const skill = { ...makeSkill("bad-hash"), artifactHash: "f".repeat(64) };
    await expect(store.stageSkill("s", "r", skill)).rejects.toThrow(/does not match/);
  });

  it("saves, loads, lists, updates and removes canonical bundles", async () => {
    const root = await tmpDir();
    const home = await tmpDir();
    const store = new ArtifactStore({ projectRoot: root, homeDir: home });
    const skill = makeSkill("payments-review");
    const dir = await store.saveCanonical(skill, makeRecord(skill), "project");
    expect(dir).toBe(path.join(root, ".dynamic-skills/bundles/payments-review"));
    expect((await readdir(dir)).sort()).toEqual(["bundle.json", "skill"]);
    const loaded = await store.loadBundle("payments-review", "project");
    expect(loaded?.record.artifactHash).toBe(skill.artifactHash);
    expect(loaded?.files).toEqual(skill.files);
    expect(await store.loadBundle("missing-skill", "project")).toBeUndefined();

    // Same content again: allowed (idempotent).
    await store.saveCanonical(skill, makeRecord(skill, { skillVersion: "1.0.1" }), "project");

    const personal = makeSkill("generic-helper");
    await store.saveCanonical(personal, makeRecord(personal, { repositoryId: "*" }), "personal");
    expect(await stat(path.join(home, ".dynamic-skills/bundles/generic-helper/bundle.json"))).toBeTruthy();

    await mkdir(path.join(root, ".dynamic-skills/bundles/garbage"), { recursive: true });
    await writeFile(path.join(root, ".dynamic-skills/bundles/garbage/bundle.json"), "{not json");
    expect((await store.listBundles("project")).map((r) => r.name)).toEqual(["payments-review"]);
    expect((await store.listBundles("personal")).map((r) => r.name)).toEqual(["generic-helper"]);

    const updated = await store.updateRecord("payments-review", "project", { lifecycleStatus: "invalidated" });
    expect(updated.lifecycleStatus).toBe("invalidated");
    expect(updated.updatedAt).not.toBe("2026-01-01T00:00:00.000Z");
    await expect(store.updateRecord("payments-review", "project", { artifactHash: "x" })).rejects.toThrow(DynamicSkillsError);
    await expect(store.updateRecord("nope-skill", "project", {})).rejects.toThrow(DynamicSkillsError);

    await store.removeBundle("payments-review", "project");
    expect(await store.loadBundle("payments-review", "project")).toBeUndefined();
  });

  it("refuses to overwrite a different existing bundle without approval", async () => {
    const root = await tmpDir();
    const store = new ArtifactStore({ projectRoot: root });
    const v1 = makeSkill("svc-skill", "v1");
    const v2 = makeSkill("svc-skill", "v2");
    await store.saveCanonical(v1, makeRecord(v1), "project");
    await expect(store.saveCanonical(v2, makeRecord(v2), "project")).rejects.toThrow(/already exists/);
    expect((await store.loadBundle("svc-skill", "project"))?.record.artifactHash).toBe(v1.artifactHash);
    await store.saveCanonical(v2, makeRecord(v2), "project", { overwrite: true });
    expect((await store.loadBundle("svc-skill", "project"))?.record.artifactHash).toBe(v2.artifactHash);
    await expect(store.saveCanonical(v1, makeRecord(v2), "project", { overwrite: true })).rejects.toThrow(/does not describe/);
  });

  it("cleans expired runs by run.json updatedAt or mtime", async () => {
    const root = await tmpDir();
    const store = new ArtifactStore({ projectRoot: root });
    const now = new Date("2026-06-01T12:00:00Z");
    const oldRun = runDir(root, "ses_a", "run_old");
    const freshRun = runDir(root, "ses_a", "run_fresh");
    const mtimeRun = runDir(root, "ses_b", "run_mtime");
    for (const d of [oldRun, freshRun, mtimeRun]) await mkdir(d, { recursive: true });
    await writeFile(path.join(oldRun, "run.json"), JSON.stringify({ updatedAt: "2026-05-30T00:00:00Z" }));
    await writeFile(path.join(freshRun, "run.json"), JSON.stringify({ updatedAt: "2026-06-01T11:00:00Z" }));
    const old = new Date("2026-05-01T00:00:00Z");
    await utimes(mtimeRun, old, old);
    const { removedRuns } = await store.cleanExpired({ retentionHours: 24, now });
    expect(removedRuns).toEqual(["ses_a/run_old", "ses_b/run_mtime"]);
    expect(await stat(freshRun)).toBeTruthy();
    await expect(stat(path.join(runtimeRoot(root), "sessions/ses_b"))).rejects.toThrow();
    expect(await store.cleanExpired({ retentionHours: 24, now })).toEqual({ removedRuns: [] });
  });
});
