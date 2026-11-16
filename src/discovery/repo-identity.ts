import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "../core/index.js";

const GIT_TIMEOUT_MS = 2_000;

function git(root: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      "git",
      // Disable fsmonitor/hooks-adjacent features; never prompt for credentials.
      ["-c", "core.fsmonitor=false", "-C", root, ...args],
      { timeout: GIT_TIMEOUT_MS, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" } },
      (err, stdout) => {
        if (err) return resolve(undefined);
        const out = String(stdout).trim();
        resolve(out || undefined);
      },
    );
  });
}

/**
 * Normalize a git remote so https/ssh forms of the same repository match:
 * "git@github.com:Org/Repo.git" and "https://user:tok@GitHub.com/Org/Repo" → "github.com/Org/Repo".
 */
export function normalizeRemoteUrl(url: string): string {
  let u = url.trim();
  const scp = /^([^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(u);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) {
    u = `${scp[2]}/${scp[3]}`;
  } else {
    u = u.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^[^@/]*@/, "");
  }
  u = u.replace(/\.git\/?$/, "").replace(/\/+$/, "");
  const slash = u.indexOf("/");
  const host = (slash < 0 ? u : u.slice(0, slash)).toLowerCase().replace(/:(22|443|80)$/, "");
  return slash < 0 ? host : `${host}${u.slice(slash)}`;
}

/** §4.3 repository identity: stable id from the origin remote (or real path), plus HEAD revision and branch. */
export async function getRepositoryIdentity(root: string): Promise<{ repositoryId: string; revision?: string; branch?: string }> {
  const abs = path.resolve(root);
  const [remote, revision, branch] = await Promise.all([
    git(abs, ["remote", "get-url", "origin"]),
    git(abs, ["rev-parse", "--verify", "-q", "HEAD"]),
    git(abs, ["rev-parse", "--abbrev-ref", "HEAD"]),
  ]);
  const basis = remote ? normalizeRemoteUrl(remote) : await realpath(abs).catch(() => abs);
  return {
    repositoryId: `repo_${sha256(basis).slice(0, 16)}`,
    ...(revision && /^[0-9a-f]{7,64}$/.test(revision) ? { revision } : {}),
    ...(branch && branch !== "HEAD" ? { branch } : {}),
  };
}
