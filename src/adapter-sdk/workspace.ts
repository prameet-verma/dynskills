import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "../core/index.js";

async function readText(p: string): Promise<string | undefined> {
  return readFile(p, "utf8").catch(() => undefined);
}

/** Locate the git directory for `root` (supports `.git` files used by worktrees). No shell is spawned. */
async function gitDir(root: string): Promise<string | undefined> {
  const dotGit = path.join(root, ".git");
  const st = await stat(dotGit).catch(() => undefined);
  if (!st) return undefined;
  if (st.isDirectory()) return dotGit;
  const m = /^gitdir:\s*(.+)\s*$/m.exec((await readText(dotGit)) ?? "");
  return m?.[1] ? path.resolve(root, m[1].trim()) : undefined;
}

function normalizeRemote(url: string): string {
  return url
    .trim()
    .replace(/\.git$/, "")
    .replace(/^[a-z+]+:\/\/(?:[^@/]+@)?/i, "")
    .replace(/^[^@/]+@([^:]+):/, "$1/")
    .toLowerCase();
}

/**
 * Best-effort repository identity and revision without spawning git:
 * repositoryId = "repo_" + sha256(normalized origin URL, or absolute root path)[0..16].
 */
export async function readRepositoryIdentity(root: string): Promise<{ repositoryId: string; revision?: string }> {
  const abs = path.resolve(root);
  const dir = await gitDir(abs);
  let identity = `path:${abs}`;
  let revision: string | undefined;
  if (dir) {
    // Worktrees keep config in the common dir.
    const commonRel = (await readText(path.join(dir, "commondir")))?.trim();
    const common = commonRel ? path.resolve(dir, commonRel) : dir;
    const config = (await readText(path.join(common, "config"))) ?? "";
    const origin = /\[remote "origin"\][^[]*?\burl\s*=\s*(\S+)/.exec(config)?.[1];
    if (origin) identity = `remote:${normalizeRemote(origin)}`;
    const head = (await readText(path.join(dir, "HEAD")))?.trim();
    if (head?.startsWith("ref:")) {
      const ref = head.slice(4).trim();
      revision =
        (await readText(path.join(common, ref)))?.trim() ??
        new RegExp(`^([0-9a-f]{40})\\s+${ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m").exec((await readText(path.join(common, "packed-refs"))) ?? "")?.[1];
    } else if (head && /^[0-9a-f]{40}$/.test(head)) {
      revision = head;
    }
  }
  return { repositoryId: `repo_${sha256(identity).slice(0, 16)}`, ...(revision ? { revision } : {}) };
}
