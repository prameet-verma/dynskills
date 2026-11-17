import { describe, it, expect, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import plugin, {
  applyLiveSkills,
  commandPrompt,
  createDynamicSkillsPlugin,
  liveSkillsFileFor,
  readLiveSkills,
  resolveBrands,
} from "../../plugins/opencode/dynskills.js";
import type { LiveSkill, SkillEditorLike, SkillInfoLike } from "../../plugins/opencode/dynskills.js";
import { OpenCodeAdapter } from "../../src/adapters/index.js";
import { makeSkill, tmpDir } from "../storage/helpers.js";

function fakeEditor(initial: SkillInfoLike[] = []): SkillEditorLike & { map: Map<string, SkillInfoLike> } {
  const map = new Map(initial.map((s) => [s.id, { ...s }]));
  return {
    map,
    list: () => [...map.values()],
    get: (id) => map.get(id),
    add: (s) => {
      if (map.has(s.id)) throw new Error(`duplicate ${s.id}`);
      map.set(s.id, { ...s });
    },
    update: (id, fn) => {
      const s = map.get(id);
      if (!s) throw new Error(`missing ${id}`);
      fn(s);
    },
    remove: (id) => {
      map.delete(id);
    },
  };
}

const live = (id: string, content = `${id} body`, p = `/gone/${id}/SKILL.md`): LiveSkill => ({ id, name: id, description: `Use for ${id}`, path: p, content });

describe("OpenCode plugin core: readLiveSkills", () => {
  it("returns [] for a missing file, undefined for malformed JSON, and drops invalid entries", async () => {
    const dir = await tmpDir();
    const file = path.join(dir, "opencode.json");
    expect(readLiveSkills(file)).toEqual([]);
    await writeFile(file, "{not json");
    expect(readLiveSkills(file)).toBeUndefined();
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        skills: [
          { ...live("good-skill"), skillId: "good-skill@1", artifactHash: "1" },
          { ...live("Bad Id") },
          { ...live("rel-path"), path: "relative/SKILL.md" },
          { id: "no-content", name: "x", path: "/a/SKILL.md" },
          live("good-skill", "last wins"),
        ],
      }),
    );
    expect(readLiveSkills(file)).toEqual([live("good-skill", "last wins")]);
  });
});

describe("OpenCode plugin core: applyLiveSkills (fake editor)", () => {
  it("adds, updates and removes on change", () => {
    const editor = fakeEditor([{ id: "user-skill", name: "user-skill", path: "/u/SKILL.md", content: "mine" }]);
    const state = { owned: new Set<string>() };
    const r1 = applyLiveSkills(editor, [live("alpha"), live("beta")], state);
    expect(r1).toMatchObject({ added: ["alpha", "beta"], updated: [], removed: [] });
    expect(editor.get("alpha")).toEqual(live("alpha"));

    const r2 = applyLiveSkills(editor, [live("alpha", "alpha v2")], state);
    expect(r2).toMatchObject({ added: [], updated: ["alpha"], removed: ["beta"] });
    expect(editor.get("alpha")?.content).toBe("alpha v2");
    expect(editor.get("beta")).toBeUndefined();
    expect(editor.get("user-skill")?.content).toBe("mine");

    const r3 = applyLiveSkills(editor, [], state);
    expect(r3.removed).toEqual(["alpha"]);
    expect(editor.list().map((s) => s.id)).toEqual(["user-skill"]);
  });

  it("keeps a dropped skill whose SKILL.md still exists on disk (directory discovery owns it)", () => {
    const editor = fakeEditor();
    const state = { owned: new Set<string>() };
    applyLiveSkills(editor, [live("kept", "c", "/on-disk/kept/SKILL.md")], state);
    const r = applyLiveSkills(editor, [], state, { fileExists: (p) => p === "/on-disk/kept/SKILL.md" });
    expect(r.removed).toEqual([]);
    expect(editor.get("kept")).toBeDefined();
  });

  it("is correct when the transform is replayed against a fresh registry", () => {
    const state = { owned: new Set<string>() };
    applyLiveSkills(fakeEditor(), [live("alpha"), live("beta")], state);
    const fresh = fakeEditor();
    expect(applyLiveSkills(fresh, [live("alpha")], state)).toMatchObject({ added: ["alpha"], removed: [] });
    expect(fresh.list().map((s) => s.id)).toEqual(["alpha"]);
  });

  it("uses @opencode/plugin brand constructors when available and isolates per-skill errors", () => {
    const brands = resolveBrands({ Skill: { ID: { make: (v: string) => `id:${v}` }, Name: { make: (v: string) => `name:${v}` } } });
    const editor = fakeEditor();
    applyLiveSkills(editor, [live("alpha")], { owned: new Set() }, { brands });
    expect(editor.get("id:alpha")).toMatchObject({ name: "name:alpha", path: "/gone/alpha/SKILL.md" });
    const throwing = fakeEditor();
    throwing.add = () => {
      throw new Error("schema rejected");
    };
    expect(applyLiveSkills(throwing, [live("alpha")]).errors).toEqual([{ id: "alpha", message: "schema rejected" }]);
  });
});

describe("OpenCode plugin: setup with a fake V2 context", () => {
  function fakeCtx(root: string, opts: { withSkill?: boolean } = {}) {
    const editor = fakeEditor();
    const transforms: Array<(e: SkillEditorLike) => void> = [];
    const commands: Array<{ name: string; description?: string; execute: (i: unknown) => Promise<void> }> = [];
    const prompts: unknown[] = [];
    let reloads = 0;
    let disposed = 0;
    const ctx = {
      location: { directory: root, project: { id: "p", directory: root, canonical: root } },
      options: {},
      session: { prompt: async (p: unknown) => void prompts.push(p) },
      command: {
        transform: async (cb: (e: { add: (c: (typeof commands)[number]) => void }) => void) => {
          cb({ add: (c) => commands.push(c) });
          return { dispose: () => void disposed++ };
        },
      },
      ...(opts.withSkill === false
        ? {}
        : {
            skill: {
              transform: async (cb: (e: SkillEditorLike) => void) => {
                transforms.push(cb);
                cb(editor);
                return { dispose: () => void disposed++ };
              },
              reload: async () => {
                reloads++;
                for (const cb of transforms) cb(editor);
              },
            },
          }),
    };
    return { ctx, editor, commands, prompts, get reloads() { return reloads; }, get disposed() { return disposed; } };
  }

  it("default export is a { id, setup } plugin definition (fallback without @opencode/plugin)", () => {
    expect(plugin.id).toBe("dynskills");
    expect(typeof plugin.setup).toBe("function");
  });

  it("adds the dynamic-skills command which prompts the session with --force-generate", async () => {
    const root = await tmpDir();
    const f = fakeCtx(root);
    const cleanup = await createDynamicSkillsPlugin().setup(f.ctx);
    expect(f.commands.map((c) => c.name)).toEqual(["dynskills"]);
    await f.commands[0]!.execute({ sessionID: "ses_1", prompt: { text: "migrate the billing module", files: [] }, delivery: "steer" });
    expect(f.prompts[0]).toMatchObject({ sessionID: "ses_1", delivery: "steer", files: [] });
    const text = (f.prompts[0] as { text: string }).text;
    expect(text).toContain("--force-generate");
    expect(text).toContain("Task: migrate the billing module");
    expect(commandPrompt("")).toMatch(/Ask the user/);
    cleanup();
    expect(f.disposed).toBe(2);
  });

  it("degrades gracefully when ctx.skill is missing", async () => {
    const root = await tmpDir();
    const f = fakeCtx(root, { withSkill: false });
    const cleanup = await createDynamicSkillsPlugin().setup(f.ctx);
    expect(typeof cleanup).toBe("function");
    cleanup();
    expect(await createDynamicSkillsPlugin().setup({}).then((c) => typeof c)).toBe("function");
  });

  it.each([
    ["the live-skills directory exists (fs.watch)", true],
    ["the live-skills directory does not exist yet (polling)", false],
  ])("registers skills live and reloads on file change when %s", async (_label, precreate) => {
    const root = await tmpDir();
    const homeDir = await tmpDir();
    if (precreate) await mkdir(path.dirname(liveSkillsFileFor(root)), { recursive: true });
    const f = fakeCtx(root);
    const cleanup = await createDynamicSkillsPlugin({ debounceMs: 20, pollIntervalMs: 50 }).setup(f.ctx);
    expect(f.editor.list()).toEqual([]);

    const adapter = new OpenCodeAdapter({ projectRoot: root, homeDir, env: { PATH: "" } });
    const skill = makeSkill("live-skill", "Live body");
    expect((await adapter.loadSkillForSession(skill)).success).toBe(true);
    await vi.waitFor(() => expect(f.editor.get("live-skill")).toBeDefined(), { timeout: 5000, interval: 25 });
    expect(f.editor.get("live-skill")).toMatchObject({
      name: "live-skill",
      path: path.join(root, ".opencode/skills/live-skill/SKILL.md"),
      content: expect.stringContaining("Live body"),
    });
    const reloadsAfterAdd = f.reloads;
    expect(reloadsAfterAdd).toBeGreaterThanOrEqual(1);

    await adapter.removeSkill(skill.skillId, "ephemeral");
    await vi.waitFor(() => expect(f.editor.get("live-skill")).toBeUndefined(), { timeout: 5000, interval: 25 });
    expect(f.reloads).toBeGreaterThan(reloadsAfterAdd);

    cleanup();
    const reloadsAtCleanup = f.reloads;
    await adapter.loadSkillForSession(makeSkill("after-cleanup"));
    await new Promise((r) => setTimeout(r, 200));
    expect(f.reloads).toBe(reloadsAtCleanup);
  });

  it("picks up skills already listed at startup", async () => {
    const root = await tmpDir();
    const file = liveSkillsFileFor(root);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ version: 1, skills: [live("existing-skill")] }));
    const f = fakeCtx(root);
    const cleanup = await createDynamicSkillsPlugin().setup(f.ctx);
    expect(f.editor.get("existing-skill")).toEqual(live("existing-skill"));
    cleanup();
  });
});
