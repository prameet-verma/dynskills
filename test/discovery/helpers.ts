import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DiscoveryLimits, DiscoveryReport, TaskIntent } from "../../src/contracts/index.js";
import { DEFAULT_DISCOVERY_LIMITS } from "../../src/context-packet/index.js";
import { RepositoryScanner } from "../../src/discovery/index.js";

export const FIXTURES = fileURLToPath(new URL("../../fixtures/", import.meta.url));
export const fixture = (name: string): string => path.join(FIXTURES, name);

export const LIMITS: DiscoveryLimits = { ...DEFAULT_DISCOVERY_LIMITS };

export const TASK: TaskIntent = { description: "Add a refund endpoint to the payments API" };

export async function scanFixture(name: string, task: TaskIntent = TASK, limits: DiscoveryLimits = LIMITS): Promise<DiscoveryReport> {
  return new RepositoryScanner().scan({ root: fixture(name), task, limits });
}

export async function tmpDir(prefix = "ds-test-"): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

/** Copy a fixture to a temp dir and guarantee excluded/sensitive files exist (node_modules is gitignored). */
export async function fixtureCopyWithExclusions(name: string): Promise<string> {
  const dir = await tmpDir();
  await cp(fixture(name), dir, { recursive: true });
  await mkdir(path.join(dir, "node_modules", "left-pad"), { recursive: true });
  await writeFile(path.join(dir, "node_modules", "left-pad", "index.js"), "module.exports = () => 'payments refund';\n");
  await mkdir(path.join(dir, "dist"), { recursive: true });
  await writeFile(path.join(dir, "dist", "payments.js"), "// built output\n");
  await writeFile(path.join(dir, ".env.local"), "SECRET_TOKEN=FAKE-local-secret-000000000\n");
  await writeFile(path.join(dir, "server.pem"), "-----BEGIN FAKE-----\n");
  return dir;
}
