import { readFile } from "node:fs/promises";
import type { ContextFingerprint } from "../contracts/index.js";
import { resolveInsideRoot, resolveRealInsideRoot, sha256, stableStringify, toPosix } from "../core/index.js";

export const MISSING_COMPONENT = "missing";

/**
 * §10.5 / §10.6 context fingerprint over only the information relevant to a skill:
 * `file:<path>` → sha256 of the file content (or "missing"), `fact:<key>` → fact value.
 * The git revision is deliberately NOT part of the fingerprint (never regenerate on revision alone).
 * Files are read only inside `root`; traversal or symlinks escaping root throw a security error.
 */
export async function computeContextFingerprint(input: {
  root: string;
  repositoryId: string;
  dependsOn: string[];
  facts?: Record<string, string>;
}): Promise<ContextFingerprint> {
  const components: Record<string, string> = {};
  const files = [...new Set(input.dependsOn.map((p) => toPosix(p).replace(/^\.\//, "")))].sort();
  await Promise.all(
    files.map(async (rel) => {
      resolveInsideRoot(input.root, rel); // lexical traversal check (throws)
      let real: string;
      try {
        real = await resolveRealInsideRoot(input.root, rel);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT" || (err as NodeJS.ErrnoException).code === "ENOTDIR") {
          components[`file:${rel}`] = MISSING_COMPONENT;
          return;
        }
        throw err;
      }
      try {
        components[`file:${rel}`] = sha256(await readFile(real));
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "EISDIR") components[`file:${rel}`] = MISSING_COMPONENT;
        else throw err;
      }
    }),
  );
  for (const [key, value] of Object.entries(input.facts ?? {})) components[`fact:${key}`] = String(value);
  const sorted = Object.fromEntries(Object.keys(components).sort().map((k) => [k, components[k] as string]));
  return { repositoryId: input.repositoryId, overall: sha256(stableStringify(sorted)), components: sorted };
}
