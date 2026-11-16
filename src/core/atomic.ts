import { mkdir, rename, rm, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { SkillFile } from "../contracts/index.js";
import { dsError } from "./errors.js";
import { resolveInsideRoot } from "./fs-safety.js";

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}

/** Write a file atomically (temp file in the same directory, then rename). */
export async function writeFileAtomic(filePath: string, content: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID().slice(0, 8)}.tmp`);
  try {
    await writeFile(tmp, content);
    await rename(tmp, filePath);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

/**
 * §16.3 Write a set of files as one directory atomically: stage in a sibling temp directory,
 * then rename into place. Refuses to replace an existing directory unless `overwrite` is true,
 * in which case the old directory is moved aside and removed only after the swap succeeds.
 */
export async function writeDirAtomic(
  destDir: string,
  files: readonly SkillFile[],
  opts: { overwrite?: boolean } = {},
): Promise<void> {
  const parent = path.dirname(destDir);
  await mkdir(parent, { recursive: true });
  const staging = path.join(parent, `.${path.basename(destDir)}.staging-${randomUUID().slice(0, 8)}`);
  try {
    for (const f of files) {
      const target = resolveInsideRoot(staging, f.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, f.content);
    }
    if (await exists(destDir)) {
      if (!opts.overwrite) {
        throw dsError("persistence", "storage", `Refusing to overwrite existing directory: ${destDir}`, {
          recoverable: true,
          fallbackAction: "Ask the user for explicit approval or choose a different name.",
        });
      }
      const backup = `${staging}.old`;
      await rename(destDir, backup);
      try {
        await rename(staging, destDir);
      } catch (err) {
        await rename(backup, destDir);
        throw err;
      }
      await rm(backup, { recursive: true, force: true });
    } else {
      await rename(staging, destDir);
    }
  } catch (err) {
    await rm(staging, { recursive: true, force: true });
    throw err;
  }
}
