import { readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { CanonicalBundleRecord, GeneratedSkill, SkillFile } from "../contracts/index.js";
import { dsError, hashSkillFiles, isoNow, readJsonIfExists, toPosix, writeDirAtomic, writeJson } from "../core/index.js";
import { bundleDir, bundleRoot, ensureRuntimeRoot, sessionsDir, stagedSkillDir } from "./paths.js";
import { assertSafeSkillName } from "./skill-md.js";

export type PersistentScope = "project" | "personal";

const BUNDLE_RECORD_FILE = "bundle.json";
const BUNDLE_SKILL_DIR = "skill";

async function pathExists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}

/** Recursively read a skill directory: POSIX relative paths, sorted by path. */
export async function readSkillDir(dir: string): Promise<SkillFile[]> {
  const out: SkillFile[] = [];
  async function walk(abs: string, rel: string): Promise<void> {
    const entries = await readdir(abs, { withFileTypes: true });
    for (const e of entries) {
      const childAbs = path.join(abs, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(childAbs, childRel);
      else if (e.isFile()) out.push({ path: toPosix(childRel), content: await readFile(childAbs, "utf8") });
      // Symlinks and special files are intentionally ignored: they are never part of a generated bundle.
    }
  }
  await walk(dir, "");
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Hash of the files currently on disk in `dir`, or undefined when the directory does not exist. */
export async function hashSkillDir(dir: string): Promise<string | undefined> {
  if (!(await pathExists(dir))) return undefined;
  return hashSkillFiles(await readSkillDir(dir));
}

function assertSkillIntegrity(skill: GeneratedSkill): void {
  assertSafeSkillName(skill.name);
  const actual = hashSkillFiles(skill.files);
  if (actual !== skill.artifactHash) {
    throw dsError("persistence", "storage", `Skill ${skill.name} artifactHash does not match its files (expected ${skill.artifactHash}, got ${actual})`, {
      recoverable: false,
      fallbackAction: "Re-render the skill so artifactHash is computed from its files.",
    });
  }
}

/**
 * §10.2 / §10.5 / §16.3 artifact storage: staged run artifacts under `.dynamic-skills-runtime`
 * and canonical bundles (independent of installed copies) under `.dynamic-skills/bundles`.
 */
export class ArtifactStore {
  readonly projectRoot: string;
  readonly homeDir: string | undefined;

  constructor(opts: { projectRoot: string; homeDir?: string }) {
    this.projectRoot = path.resolve(opts.projectRoot);
    this.homeDir = opts.homeDir;
  }

  private rootOpts(): { projectRoot: string; homeDir?: string } {
    return this.homeDir !== undefined ? { projectRoot: this.projectRoot, homeDir: this.homeDir } : { projectRoot: this.projectRoot };
  }

  /** Atomically write the skill into the run's staging dir (replacing an earlier revision of the same run). */
  async stageSkill(sessionId: string, runId: string, skill: GeneratedSkill): Promise<string> {
    assertSkillIntegrity(skill);
    const dir = stagedSkillDir(this.projectRoot, sessionId, runId, skill.name);
    await ensureRuntimeRoot(this.projectRoot);
    await writeDirAtomic(dir, skill.files, { overwrite: true });
    if (!(await this.verifyHash(dir, skill.artifactHash))) {
      throw dsError("persistence", "storage", `Staged skill hash mismatch at ${dir}`, { recoverable: true, fallbackAction: "Retry staging." });
    }
    return dir;
  }

  readSkillDir(dir: string): Promise<SkillFile[]> {
    return readSkillDir(dir);
  }

  async verifyHash(dir: string, expectedHash: string): Promise<boolean> {
    try {
      return (await hashSkillDir(dir)) === expectedHash;
    } catch {
      return false;
    }
  }

  /**
   * Save the canonical bundle: `<bundleRoot>/<name>/skill/**` + `<bundleRoot>/<name>/bundle.json`.
   * Refuses to replace an existing bundle with different content unless `overwrite` is set (§16.3).
   */
  async saveCanonical(
    skill: GeneratedSkill,
    record: CanonicalBundleRecord,
    scope: PersistentScope,
    opts: { overwrite?: boolean } = {},
  ): Promise<string> {
    assertSkillIntegrity(skill);
    if (record.artifactHash !== skill.artifactHash || record.name !== skill.name) {
      throw dsError("persistence", "storage", `Bundle record does not describe skill ${skill.name}@${skill.artifactHash.slice(0, 12)}`, {
        recoverable: false,
        fallbackAction: "Rebuild the bundle record from the generated skill.",
      });
    }
    const dir = bundleDir(scope, skill.name, this.rootOpts());
    let replace = false;
    if (await pathExists(dir)) {
      const existing = await readJsonIfExists<CanonicalBundleRecord>(path.join(dir, BUNDLE_RECORD_FILE)).catch(() => undefined);
      const sameContent = existing?.artifactHash === skill.artifactHash && (await this.verifyHash(path.join(dir, BUNDLE_SKILL_DIR), skill.artifactHash));
      if (!sameContent && !opts.overwrite) {
        throw dsError("persistence", "storage", `A different bundle named "${skill.name}" already exists in ${scope} storage`, {
          recoverable: true,
          fallbackAction: "Ask the user for explicit approval to overwrite, or choose a different skill name.",
        });
      }
      replace = true;
    }
    const files: SkillFile[] = [
      ...skill.files.map((f) => ({ path: `${BUNDLE_SKILL_DIR}/${f.path}`, content: f.content })),
      { path: BUNDLE_RECORD_FILE, content: `${JSON.stringify(record, null, 2)}\n` },
    ];
    await writeDirAtomic(dir, files, { overwrite: replace });
    if (!(await this.verifyHash(path.join(dir, BUNDLE_SKILL_DIR), skill.artifactHash))) {
      throw dsError("persistence", "storage", `Canonical bundle hash mismatch after write: ${dir}`, {
        recoverable: true,
        fallbackAction: "Keep the skill ephemeral and report the persistence failure.",
      });
    }
    return dir;
  }

  async loadBundle(name: string, scope: PersistentScope): Promise<{ record: CanonicalBundleRecord; files: SkillFile[] } | undefined> {
    const dir = bundleDir(scope, name, this.rootOpts());
    const record = await readJsonIfExists<CanonicalBundleRecord>(path.join(dir, BUNDLE_RECORD_FILE));
    if (!record) return undefined;
    const skillDir = path.join(dir, BUNDLE_SKILL_DIR);
    const files = (await pathExists(skillDir)) ? await readSkillDir(skillDir) : [];
    return { record, files };
  }

  /** All readable bundle records in a scope (malformed bundles are skipped). */
  async listBundles(scope: PersistentScope): Promise<CanonicalBundleRecord[]> {
    const root = bundleRoot(scope, this.rootOpts());
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    const records: CanonicalBundleRecord[] = [];
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const rec = await readJsonIfExists<CanonicalBundleRecord>(path.join(root, e.name, BUNDLE_RECORD_FILE)).catch(() => undefined);
      if (rec && typeof rec === "object" && typeof rec.name === "string" && typeof rec.artifactHash === "string") records.push(rec);
    }
    return records.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Merge a patch into bundle.json. `name` and `artifactHash` are immutable here; `updatedAt` is refreshed. */
  async updateRecord(name: string, scope: PersistentScope, patch: Partial<CanonicalBundleRecord>): Promise<CanonicalBundleRecord> {
    const dir = bundleDir(scope, name, this.rootOpts());
    const file = path.join(dir, BUNDLE_RECORD_FILE);
    const current = await readJsonIfExists<CanonicalBundleRecord>(file);
    if (!current) {
      throw dsError("persistence", "storage", `No canonical bundle named "${name}" in ${scope} storage`, { recoverable: true, fallbackAction: "Save the bundle first." });
    }
    if ((patch.name !== undefined && patch.name !== current.name) || (patch.artifactHash !== undefined && patch.artifactHash !== current.artifactHash)) {
      throw dsError("invalid_state", "storage", "updateRecord cannot change a bundle's name or artifactHash; save a new canonical bundle instead", {
        recoverable: true,
        fallbackAction: "Use saveCanonical with overwrite approval.",
      });
    }
    const next: CanonicalBundleRecord = { ...current, ...patch, name: current.name, artifactHash: current.artifactHash, updatedAt: patch.updatedAt ?? isoNow() };
    await writeJson(file, next);
    return next;
  }

  async removeBundle(name: string, scope: PersistentScope): Promise<void> {
    await rm(bundleDir(scope, name, this.rootOpts()), { recursive: true, force: true });
  }

  /**
   * Remove run directories older than the retention window. Age is taken from `run.json`'s
   * `updatedAt` when present, otherwise from the run directory's mtime. Empty sessions are removed.
   */
  async cleanExpired(opts: { retentionHours: number; now?: Date }): Promise<{ removedRuns: string[] }> {
    const now = (opts.now ?? new Date()).getTime();
    const cutoff = now - opts.retentionHours * 3_600_000;
    const sessions = sessionsDir(this.projectRoot);
    const removedRuns: string[] = [];
    const sessionEntries = await readdir(sessions, { withFileTypes: true }).catch(() => []);
    for (const s of sessionEntries) {
      if (!s.isDirectory()) continue;
      const runsDir = path.join(sessions, s.name, "runs");
      const runEntries = await readdir(runsDir, { withFileTypes: true }).catch(() => []);
      for (const r of runEntries) {
        if (!r.isDirectory()) continue;
        const dir = path.join(runsDir, r.name);
        const updated = await runUpdatedAt(dir);
        if (updated !== undefined && updated < cutoff) {
          await rm(dir, { recursive: true, force: true });
          removedRuns.push(`${s.name}/${r.name}`);
        }
      }
      const remaining = await readdir(runsDir).catch(() => []);
      if (remaining.length === 0) {
        const sessionRest = (await readdir(path.join(sessions, s.name)).catch(() => [])).filter((n) => n !== "runs");
        if (sessionRest.length === 0) await rm(path.join(sessions, s.name), { recursive: true, force: true });
      }
    }
    return { removedRuns: removedRuns.sort() };
  }
}

async function runUpdatedAt(dir: string): Promise<number | undefined> {
  const meta = await readJsonIfExists<{ updatedAt?: unknown }>(path.join(dir, "run.json")).catch(() => undefined);
  if (meta && typeof meta.updatedAt === "string") {
    const t = Date.parse(meta.updatedAt);
    if (Number.isFinite(t)) return t;
  }
  const st = await stat(dir).catch(() => undefined);
  return st?.mtimeMs;
}
