import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { dsError, resolveInsideRoot } from "../core/index.js";
import { assertSafeSkillName } from "./skill-md.js";

export const RUNTIME_DIR_NAME = ".dynamic-skills-runtime";
export const CANONICAL_DIR_NAME = ".dynamic-skills";

/** Safe single path segment for session/run ids (no separators, no dot-dot). */
const ID_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

function assertIdSegment(kind: string, value: string): void {
  if (!ID_SEGMENT_RE.test(value) || value.includes("..")) {
    throw dsError("security", "storage", `Invalid ${kind}: ${JSON.stringify(value)}`, { recoverable: true, fallbackAction: "Use a plain identifier without path separators." });
  }
}

/** §10.2 repository-local runtime root (self-ignoring; never edits the user's .gitignore). */
export function runtimeRoot(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), RUNTIME_DIR_NAME);
}

/** Create the runtime root with a `.gitignore` containing `*` so git ignores it entirely. */
export async function ensureRuntimeRoot(projectRoot: string): Promise<string> {
  const root = runtimeRoot(projectRoot);
  await mkdir(root, { recursive: true });
  const gi = path.join(root, ".gitignore");
  const current = await readFile(gi, "utf8").catch(() => undefined);
  if (current === undefined || current.trim() !== "*") await writeFile(gi, "*\n");
  return root;
}

export function sessionsDir(projectRoot: string): string {
  return path.join(runtimeRoot(projectRoot), "sessions");
}

/** `.dynamic-skills-runtime/sessions/<session>/runs/<run>` */
export function runDir(projectRoot: string, sessionId: string, runId: string): string {
  assertIdSegment("session id", sessionId);
  assertIdSegment("run id", runId);
  return path.join(sessionsDir(projectRoot), sessionId, "runs", runId);
}

/** `<runDir>/skills/<name>` */
export function stagedSkillDir(projectRoot: string, sessionId: string, runId: string, name: string): string {
  assertSafeSkillName(name);
  return path.join(runDir(projectRoot, sessionId, runId), "skills", name);
}

/** Canonical bundle root (§10.5): project → `<projectRoot>/.dynamic-skills/bundles`, personal → `<home>/.dynamic-skills/bundles`. */
export function bundleRoot(scope: "project" | "personal", opts: { projectRoot: string; homeDir?: string }): string {
  const base = scope === "project" ? path.resolve(opts.projectRoot) : path.resolve(opts.homeDir ?? homedir());
  return path.join(base, CANONICAL_DIR_NAME, "bundles");
}

/** `<bundleRoot>/<name>` with name validation and containment check. */
export function bundleDir(scope: "project" | "personal", name: string, opts: { projectRoot: string; homeDir?: string }): string {
  assertSafeSkillName(name);
  return resolveInsideRoot(bundleRoot(scope, opts), name);
}

/**
 * Ownership registry of skill directories installed by Dynamic Skills into native skill dirs.
 * Project/ephemeral installs: `<projectRoot>/.dynamic-skills-runtime/installs/<harness>.json`;
 * personal installs: `<home>/.dynamic-skills/installs/<harness>.json`.
 */
export function installRegistryPath(scope: "project" | "personal", harness: string, opts: { projectRoot: string; homeDir?: string }): string {
  assertIdSegment("harness id", harness);
  return scope === "project"
    ? path.join(runtimeRoot(opts.projectRoot), "installs", `${harness}.json`)
    : path.join(path.resolve(opts.homeDir ?? homedir()), CANONICAL_DIR_NAME, "installs", `${harness}.json`);
}
