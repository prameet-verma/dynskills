import { readFile } from "node:fs/promises";
import path from "node:path";
import type { HarnessId, StorageScope } from "../contracts/index.js";
import { readJsonIfExists, writeJson } from "../core/index.js";
import { hashSkillDir, hasDynamicSkillsMarker } from "../storage/index.js";

/** One skill directory installed by Dynamic Skills into a native skills directory. */
export interface InstallRegistryEntry {
  name: string;
  skillId: string;
  artifactHash: string;
  /** Absolute path of the installed skill directory. */
  path: string;
  harness: HarnessId;
  scope: StorageScope;
  installedAt: string;
}

interface RegistryFile {
  version: 1;
  entries: InstallRegistryEntry[];
}

/**
 * JSON ownership registry. Dynamic Skills only overwrites or removes skill directories it can
 * prove it installed; this file is that proof for ephemeral and persisted installs.
 */
export class InstallRegistry {
  constructor(readonly file: string) {}

  async list(): Promise<InstallRegistryEntry[]> {
    const data = await readJsonIfExists<RegistryFile>(this.file).catch(() => undefined);
    return Array.isArray(data?.entries) ? data.entries.filter((e) => e && typeof e.path === "string") : [];
  }

  async get(dir: string): Promise<InstallRegistryEntry | undefined> {
    const abs = path.resolve(dir);
    return (await this.list()).find((e) => path.resolve(e.path) === abs);
  }

  async upsert(entry: InstallRegistryEntry): Promise<void> {
    const abs = path.resolve(entry.path);
    const entries = (await this.list()).filter((e) => path.resolve(e.path) !== abs);
    entries.push({ ...entry, path: abs });
    await this.save(entries);
  }

  async remove(dir: string): Promise<void> {
    const abs = path.resolve(dir);
    const entries = await this.list();
    const kept = entries.filter((e) => path.resolve(e.path) !== abs);
    if (kept.length !== entries.length) await this.save(kept);
  }

  private async save(entries: InstallRegistryEntry[]): Promise<void> {
    const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
    await writeJson(this.file, { version: 1, entries: sorted } satisfies RegistryFile);
  }
}

export interface InstallOwnership {
  exists: boolean;
  /** Hash of the files currently on disk (undefined when the directory does not exist). */
  currentHash?: string;
  entry?: InstallRegistryEntry;
  /** True when the registry entry matches the files on disk (unmodified since Dynamic Skills installed them). */
  registeredUnmodified: boolean;
  /** True when SKILL.md carries Dynamic Skills provenance metadata. */
  hasMarker: boolean;
  /** Dynamic Skills may replace/remove this directory (registry-proven or marker-proven provenance). */
  owned: boolean;
}

/** Determine whether an existing skill directory was installed by Dynamic Skills. */
export async function inspectInstall(dir: string, registry: InstallRegistry): Promise<InstallOwnership> {
  const currentHash = await hashSkillDir(dir).catch(() => undefined);
  const entry = await registry.get(dir);
  if (currentHash === undefined) {
    return { exists: false, ...(entry ? { entry } : {}), registeredUnmodified: false, hasMarker: false, owned: false };
  }
  const skillMd = await readFile(path.join(dir, "SKILL.md"), "utf8").catch(() => "");
  const hasMarker = hasDynamicSkillsMarker(skillMd);
  const registeredUnmodified = entry !== undefined && entry.artifactHash === currentHash;
  return { exists: true, currentHash, ...(entry ? { entry } : {}), registeredUnmodified, hasMarker, owned: registeredUnmodified || hasMarker };
}

/** Name part of a skill id (`name@hash` → `name`); a bare name is returned unchanged. */
export function skillNameFromId(skillId: string): string {
  const at = skillId.indexOf("@");
  return at === -1 ? skillId : skillId.slice(0, at);
}
