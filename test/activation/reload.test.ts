import { describe, it, expect } from "vitest";
import path from "node:path";
import { DirectorySkillActivator } from "../../src/activation/index.js";
import { makeSkill, tmpDir } from "../storage/helpers.js";

function activator(root: string, sessionId?: string) {
  return new DirectorySkillActivator({
    harness: "claude",
    skillsDir: path.join(root, ".claude/skills"),
    capabilities: ["watched_directory", "current_turn_instruction_injection", "explicit_reload"],
    reloadHint: () => "run /reload-skills",
    invocationHint: (n) => `/${n}`,
    registryPath: path.join(root, ".dynamic-skills-runtime/installs/claude.json"),
    ...(sessionId ? { sessionId } : {}),
  });
}

describe("reload hints for skills directories created mid-session", () => {
  it("flags every activation into a directory the current session created", async () => {
    const root = await tmpDir();
    const first = await activator(root, "sess_a").activate(makeSkill("first-skill"));
    expect(first.requiresReload).toBe(true);
    const second = await activator(root, "sess_a").activate(makeSkill("second-skill"));
    expect(second.success).toBe(true);
    expect(second.requiresReload).toBe(true);
  });

  it("does not flag activations from a later session, which watches the directory from its start", async () => {
    const root = await tmpDir();
    await activator(root, "sess_a").activate(makeSkill("first-skill"));
    const later = await activator(root, "sess_b").activate(makeSkill("later-skill"));
    expect(later.requiresReload).toBe(false);
  });

  it("without a session id, only the creating activation is flagged", async () => {
    const root = await tmpDir();
    expect((await activator(root).activate(makeSkill("first-skill"))).requiresReload).toBe(true);
    expect((await activator(root).activate(makeSkill("second-skill"))).requiresReload).toBe(false);
  });
});
