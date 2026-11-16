import { execFileSync } from "node:child_process";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverExistingSkills, getRepositoryIdentity, normalizeRemoteUrl } from "../../src/discovery/index.js";
import { fixture, tmpDir } from "./helpers.js";

async function skill(dir: string, name: string, body: string) {
  await mkdir(path.join(dir, name), { recursive: true });
  await writeFile(path.join(dir, name, "SKILL.md"), body);
}

describe("discoverExistingSkills", () => {
  it("inventories project and personal skills, skipping malformed and escaping ones", async () => {
    const home = await tmpDir("ds-home-");
    const outside = await tmpDir("ds-outside-");
    await skill(path.join(home, ".claude/skills"), "personal-review", "---\nname: personal-review\ndescription: Reviews diffs.\n---\nbody\n");
    await skill(path.join(home, ".config/opencode/skills"), "oc-skill", "---\ndescription: OpenCode helper.\n---\n");
    await skill(path.join(home, ".agents/skills"), "bad-yaml", "---\nname: [unclosed\ndescription: x\n---\n");
    await skill(outside, "evil", "---\nname: evil\ndescription: outside\n---\n");
    await symlink(path.join(outside, "evil"), path.join(home, ".claude/skills/evil"));

    const items = await discoverExistingSkills(fixture("extensive-instructions"), { homeDir: home });
    const summary = items.map((i) => [i.scope, i.harness, i.name]);
    expect(summary).toEqual([
      ["project", "claude", "release-notes"],
      ["project", "codex", "changelog"],
      ["personal", "claude", "personal-review"],
      ["personal", "opencode", "oc-skill"],
    ]);
    expect(items[0]?.description).toContain("release notes");
    expect(items[0]?.path).toBe(path.join(fixture("extensive-instructions"), ".claude/skills/release-notes"));
  });

  it("returns an empty list when no skill directories exist", async () => {
    const home = await tmpDir("ds-home-");
    expect(await discoverExistingSkills(fixture("minimal-docs"), { homeDir: home })).toEqual([]);
  });
});

describe("getRepositoryIdentity", () => {
  it("tolerates non-git directories and is stable", async () => {
    const dir = await tmpDir();
    const a = await getRepositoryIdentity(dir);
    const b = await getRepositoryIdentity(dir);
    expect(a.repositoryId).toMatch(/^repo_[0-9a-f]{16}$/);
    expect(a.revision).toBeUndefined();
    expect(b).toEqual(a);
  });

  it("uses the normalized origin remote and HEAD revision", async () => {
    const mk = async (remote: string) => {
      const dir = await tmpDir("ds-git-");
      const git = (...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { stdio: "pipe" });
      git("init", "-q", "-b", "main");
      git("remote", "add", "origin", remote);
      await writeFile(path.join(dir, "a.txt"), "a\n");
      git("add", ".");
      git("commit", "-q", "-m", "init");
      return dir;
    };
    const https = await getRepositoryIdentity(await mk("https://GitHub.com/Example/Repo.git"));
    const ssh = await getRepositoryIdentity(await mk("git@github.com:Example/Repo.git"));
    expect(https.repositoryId).toBe(ssh.repositoryId);
    expect(https.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(https.branch).toBe("main");
  });

  it("normalizes remote URL forms", () => {
    expect(normalizeRemoteUrl("git@github.com:Org/Repo.git")).toBe("github.com/Org/Repo");
    expect(normalizeRemoteUrl("https://user:token@GitHub.com/Org/Repo/")).toBe("github.com/Org/Repo");
    expect(normalizeRemoteUrl("ssh://git@github.com:22/Org/Repo.git")).toBe("github.com/Org/Repo");
  });
});
