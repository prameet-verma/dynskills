import path from "node:path";
import type { HarnessId } from "../contracts/index.js";
import { isoNow, readJsonIfExists, writeJson } from "../core/index.js";
import { ensureRuntimeRoot, parseSkillMd, runtimeRoot } from "../storage/index.js";

/**
 * One skill registered for live (in-session) registration by a host plugin. The first five fields
 * are what the OpenCode plugin passes to its skill registry (`Skill.Info`); the rest are bookkeeping.
 */
export interface LiveSkillEntry {
  /** Registry id; Dynamic Skills uses the skill name (OpenCode derives ids from the directory name). */
  id: string;
  name: string;
  description?: string;
  /** Absolute path of the installed SKILL.md. */
  path: string;
  /** SKILL.md body without frontmatter. */
  content: string;
  skillId: string;
  artifactHash: string;
  updatedAt: string;
}

interface LiveSkillsFileData {
  version: 1;
  skills: LiveSkillEntry[];
}

/** `<projectRoot>/.dynamic-skills-runtime/live-skills/<harness>.json` (read by plugins/opencode/dynamic-skills.js). */
export function liveSkillsPath(projectRoot: string, harness: HarnessId): string {
  return path.join(runtimeRoot(projectRoot), "live-skills", `${harness}.json`);
}

/** Build a live entry from an installed skill's SKILL.md. Returns undefined when SKILL.md is malformed. */
export function liveSkillEntryFrom(input: {
  name: string;
  skillId: string;
  artifactHash: string;
  skillMd: string;
  installedPath: string;
}): LiveSkillEntry | undefined {
  const parsed = parseSkillMd(input.skillMd);
  if (!parsed) return undefined;
  return {
    id: input.name,
    name: input.name,
    description: parsed.frontmatter.description,
    path: path.join(path.resolve(input.installedPath), "SKILL.md"),
    content: parsed.body,
    skillId: input.skillId,
    artifactHash: input.artifactHash,
    updatedAt: isoNow(),
  };
}

const locks = new Map<string, Promise<unknown>>();

/** Serialise read-modify-write cycles on one file within this process. */
async function withFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(file) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  locks.set(file, tail);
  try {
    return await run;
  } finally {
    if (locks.get(file) === tail) locks.delete(file);
  }
}

/**
 * The JSON file of live skills a host plugin watches. Writes are atomic (temp file + rename), so a
 * watcher never observes a partial file. The runtime root is created self-ignoring (§10.2).
 */
export class LiveSkillsFile {
  constructor(
    readonly file: string,
    private readonly projectRoot: string,
  ) {}

  static for(projectRoot: string, harness: HarnessId): LiveSkillsFile {
    return new LiveSkillsFile(liveSkillsPath(projectRoot, harness), projectRoot);
  }

  async list(): Promise<LiveSkillEntry[]> {
    const data = await readJsonIfExists<Partial<LiveSkillsFileData>>(this.file).catch(() => undefined);
    return Array.isArray(data?.skills) ? data.skills.filter((s) => s && typeof s.id === "string") : [];
  }

  async upsert(entry: LiveSkillEntry): Promise<void> {
    await withFileLock(this.file, async () => {
      const skills = (await this.list()).filter((s) => s.id !== entry.id);
      skills.push(entry);
      await this.save(skills);
    });
  }

  /**
   * Remove entries by registry id/name or by full skill id (`name@hash`), optionally only those
   * matching `where`. Returns the removed count.
   */
  async remove(idOrSkillId: string, where: (entry: LiveSkillEntry) => boolean = () => true): Promise<number> {
    return withFileLock(this.file, async () => {
      const skills = await this.list();
      if (skills.length === 0) return 0;
      const kept = skills.filter((s) => !((s.id === idOrSkillId || s.skillId === idOrSkillId) && where(s)));
      if (kept.length !== skills.length) await this.save(kept);
      return skills.length - kept.length;
    });
  }

  private async save(skills: LiveSkillEntry[]): Promise<void> {
    await ensureRuntimeRoot(this.projectRoot);
    const sorted = [...skills].sort((a, b) => a.id.localeCompare(b.id));
    await writeJson(this.file, { version: 1, skills: sorted } satisfies LiveSkillsFileData);
  }
}
