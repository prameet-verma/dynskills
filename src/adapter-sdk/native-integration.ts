import { chmod, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessId } from "../contracts/index.js";
import { dsError, readJsonIfExists, sha256, writeFileAtomic, writeJson } from "../core/index.js";
import { CANONICAL_DIR_NAME } from "../storage/index.js";

/**
 * §9.3 / §14.2 native harness integration: ship the packaged plugins in `plugins/<harness>` to a
 * location the harness can load them from. Nothing here runs a harness CLI; for Claude Code and
 * Codex the result lists the exact commands the user runs to register and install the plugin.
 */

export type NativeIntegrationScope = "project" | "personal";
export type NativeIntegrationStatus = "created" | "updated" | "unchanged" | "conflict";

export interface NativeIntegrationAction {
  kind: "file" | "instruction";
  path?: string;
  status: NativeIntegrationStatus;
  detail: string;
}

export interface NativeIntegrationInput {
  harness: HarnessId;
  scope: NativeIntegrationScope;
  projectRoot: string;
  homeDir?: string;
  force?: boolean;
}

export interface NativeIntegrationResult {
  harness: HarnessId;
  actions: NativeIntegrationAction[];
}

/** Package root: this module lives at `<root>/src/adapter-sdk/` or `<root>/dist/adapter-sdk/`. */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const PLUGIN_SOURCE_DIRS: Readonly<Record<HarnessId, string>> = {
  claude: "claude-code",
  codex: "codex",
  opencode: "opencode",
};

/** Name of the plugin in every packaged marketplace. */
export const NATIVE_PLUGIN_NAME = "dynskills";
/** File name of the OpenCode plugin (also what the OpenCode adapter checks for). */
export const OPENCODE_PLUGIN_FILE = "dynskills.js";
/** Marker string carried by the OpenCode plugin file; identifies a copy written by Dynamic Skills. */
export const OPENCODE_PLUGIN_MARKER = "@dynskills-opencode-plugin";
/** Ownership manifest written into a copied marketplace directory. */
const MARKETPLACE_MANIFEST = ".dynamic-skills-install.json";

/** Absolute path of the packaged plugin sources for a harness (`<package>/plugins/<dir>`). */
export function pluginSourceDir(harness: HarnessId): string {
  const dir = PLUGIN_SOURCE_DIRS[harness];
  if (!dir) throw dsError("configuration", "adapter", `Unknown harness: ${String(harness)}`, { recoverable: false });
  return path.join(PACKAGE_ROOT, "plugins", dir);
}

/** OpenCode plugin directory: `.opencode/plugins` (project) or `~/.config/opencode/plugins` (personal). */
export function opencodePluginsDir(scope: NativeIntegrationScope, opts: { projectRoot: string; homeDir?: string }): string {
  return scope === "project"
    ? path.join(path.resolve(opts.projectRoot), ".opencode", "plugins")
    : path.join(path.resolve(opts.homeDir ?? homedir()), ".config", "opencode", "plugins");
}

/** Where a Claude Code / Codex marketplace is copied: `<home|project>/.dynamic-skills/marketplaces/<harness>`. */
export function nativeMarketplaceDir(harness: HarnessId, scope: NativeIntegrationScope, opts: { projectRoot: string; homeDir?: string }): string {
  const base = scope === "project" ? path.resolve(opts.projectRoot) : path.resolve(opts.homeDir ?? homedir());
  return path.join(base, CANONICAL_DIR_NAME, "marketplaces", harness);
}

interface SourceFile {
  rel: string;
  abs: string;
  executable: boolean;
}

async function listSourceFiles(root: string): Promise<SourceFile[]> {
  const out: SourceFile[] = [];
  async function walk(abs: string, rel: string): Promise<void> {
    for (const e of await readdir(abs, { withFileTypes: true })) {
      if (e.name === ".DS_Store") continue;
      const childAbs = path.join(abs, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(childAbs, childRel);
      else if (e.isFile()) {
        const mode = (await stat(childAbs)).mode;
        // npm packing may drop exec bits; anything under a bin/ directory is an executable launcher.
        out.push({ rel: childRel, abs: childAbs, executable: (mode & 0o111) !== 0 || childRel.split("/").includes("bin") });
      }
    }
  }
  await walk(root, "");
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/**
 * Write one file unless an existing, differing copy is not ours (then "conflict", nothing written).
 * `isOurs` decides ownership of an existing differing copy; `force` overrides it.
 */
async function syncFile(src: SourceFile, dest: string, opts: { force: boolean; isOurs: (current: Buffer) => boolean }): Promise<NativeIntegrationStatus> {
  const want = await readFile(src.abs);
  const current = await readFile(dest).catch(() => undefined);
  const ensureMode = async (): Promise<boolean> => {
    if (!src.executable) return false;
    const mode = (await stat(dest)).mode;
    if ((mode & 0o111) === 0o111) return false;
    await chmod(dest, 0o755);
    return true;
  };
  if (current === undefined) {
    await writeFileAtomic(dest, want);
    await ensureMode();
    return "created";
  }
  if (current.equals(want)) return (await ensureMode()) ? "updated" : "unchanged";
  if (!opts.force && !opts.isOurs(current)) return "conflict";
  await writeFileAtomic(dest, want);
  await ensureMode();
  return "updated";
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_/.:@%+=,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function fileDetail(status: NativeIntegrationStatus, what: string): string {
  switch (status) {
    case "created":
      return `Created ${what}.`;
    case "updated":
      return `Updated ${what}.`;
    case "unchanged":
      return `${what[0]?.toUpperCase() ?? ""}${what.slice(1)} is already up to date.`;
    case "conflict":
      return `A different ${what} exists that was not written by Dynamic Skills (or was edited since); left it untouched. Re-run with force to replace it.`;
  }
}

function overallStatus(actions: NativeIntegrationAction[]): NativeIntegrationStatus {
  if (actions.some((a) => a.status === "conflict")) return "conflict";
  if (actions.some((a) => a.status === "created" || a.status === "updated")) return "created";
  return "unchanged";
}

interface MarketplaceManifest {
  version: 1;
  harness: HarnessId;
  /** relative path → sha256 of the content Dynamic Skills wrote. */
  files: Record<string, string>;
}

/** Copy a packaged marketplace (Claude Code / Codex) into `.dynamic-skills/marketplaces/<harness>`. */
async function copyMarketplace(input: NativeIntegrationInput): Promise<{ dir: string; actions: NativeIntegrationAction[] }> {
  const sourceRoot = pluginSourceDir(input.harness);
  const files = await listSourceFiles(sourceRoot).catch(() => []);
  if (files.length === 0) {
    throw dsError("configuration", "adapter", `Packaged ${input.harness} plugin is missing: ${sourceRoot}`, {
      recoverable: false,
      fallbackAction: "Reinstall Dynamic Skills; the packaged plugins directory is missing.",
    });
  }
  const dir = nativeMarketplaceDir(input.harness, input.scope, input);
  const manifestPath = path.join(dir, MARKETPLACE_MANIFEST);
  const manifest = await readJsonIfExists<Partial<MarketplaceManifest>>(manifestPath).catch(() => undefined);
  const written: Record<string, string> = { ...(manifest?.files ?? {}) };
  const actions: NativeIntegrationAction[] = [];
  for (const f of files) {
    const dest = path.join(dir, ...f.rel.split("/"));
    const status = await syncFile(f, dest, {
      force: input.force ?? false,
      // Ours when the copy on disk is exactly what Dynamic Skills wrote last time (unmodified).
      isOurs: (current) => written[f.rel] === sha256(current),
    });
    if (status !== "conflict") written[f.rel] = sha256(await readFile(dest));
    actions.push({ kind: "file", path: dest, status, detail: fileDetail(status, `plugin file ${f.rel}`) });
  }
  await writeJson(manifestPath, { version: 1, harness: input.harness, files: written } satisfies MarketplaceManifest);
  return { dir, actions };
}

async function marketplaceName(file: string, fallback: string): Promise<string> {
  const data = await readJsonIfExists<{ name?: unknown }>(file).catch(() => undefined);
  return typeof data?.name === "string" && data.name ? data.name : fallback;
}

async function installClaude(input: NativeIntegrationInput): Promise<NativeIntegrationAction[]> {
  const { dir, actions } = await copyMarketplace(input);
  const status = overallStatus(actions);
  const marketplace = await marketplaceName(path.join(dir, ".claude-plugin", "marketplace.json"), "dynskills-local");
  const claudeScope = input.scope === "personal" ? "user" : "project";
  const prefix = status === "conflict" ? "After resolving the conflicts above (or re-running with force): " : "";
  const pluginDir = path.join(dir, NATIVE_PLUGIN_NAME);
  return [
    ...actions,
    {
      kind: "instruction",
      status,
      detail: `${prefix}Register the local marketplace: claude plugin marketplace add ${shellQuote(dir)}`,
    },
    {
      kind: "instruction",
      status,
      detail: `${prefix}Install the plugin (${claudeScope} scope): claude plugin install ${NATIVE_PLUGIN_NAME}@${marketplace} --scope ${claudeScope}. In a running session, run /reload-plugins to load it; plugin skills are invoked as /${NATIVE_PLUGIN_NAME}:generate-skill and /${NATIVE_PLUGIN_NAME}:dynamic-skill-bootstrap.`,
    },
    {
      kind: "instruction",
      status,
      detail: `Optional: check the plugin with claude plugin validate ${shellQuote(pluginDir)}, or try it for one session with claude --plugin-dir ${shellQuote(pluginDir)}.`,
    },
  ];
}

async function installCodex(input: NativeIntegrationInput): Promise<NativeIntegrationAction[]> {
  const { dir, actions } = await copyMarketplace(input);
  const status = overallStatus(actions);
  const marketplace = await marketplaceName(path.join(dir, ".agents", "plugins", "marketplace.json"), "dynskills-local");
  const prefix = status === "conflict" ? "After resolving the conflicts above (or re-running with force): " : "";
  return [
    ...actions,
    {
      kind: "instruction",
      status,
      detail: `${prefix}Register the local marketplace: codex plugin marketplace add ${shellQuote(dir)}`,
    },
    {
      kind: "instruction",
      status,
      detail: `${prefix}Install the plugin from inside Codex: run /plugins, open the "${marketplace}" marketplace and install "${NATIVE_PLUGIN_NAME}" (Codex documents no non-interactive install). Its skills become available in a new Codex session; invoke the bootstrap as $dynamic-skill-bootstrap.`,
    },
  ];
}

async function installOpenCode(input: NativeIntegrationInput): Promise<NativeIntegrationAction[]> {
  const source = path.join(pluginSourceDir("opencode"), OPENCODE_PLUGIN_FILE);
  const exists = await stat(source).then(
    (s) => s.isFile(),
    () => false,
  );
  if (!exists) {
    throw dsError("configuration", "adapter", `Packaged OpenCode plugin is missing: ${source}`, {
      recoverable: false,
      fallbackAction: "Reinstall Dynamic Skills; the packaged plugins directory is missing.",
    });
  }
  const dest = path.join(opencodePluginsDir(input.scope, input), OPENCODE_PLUGIN_FILE);
  const status = await syncFile({ rel: OPENCODE_PLUGIN_FILE, abs: source, executable: false }, dest, {
    force: input.force ?? false,
    isOurs: (current) => current.toString("utf8").includes(OPENCODE_PLUGIN_MARKER),
  });
  const actions: NativeIntegrationAction[] = [{ kind: "file", path: dest, status, detail: fileDetail(status, "OpenCode plugin") }];
  const prefix = status === "conflict" ? "After resolving the conflict above (or re-running with force): " : "";
  actions.push({
    kind: "instruction",
    status: status === "updated" ? "created" : status,
    detail: `${prefix}Start a new OpenCode session so it loads the plugin (OpenCode loads plugins from ${path.dirname(dest)} at startup; requires an OpenCode version with the V2 plugin API). It adds the /${NATIVE_PLUGIN_NAME} command and registers generated skills live.`,
  });
  return actions;
}

/**
 * Install the native Dynamic Skills integration for one harness. Claude Code / Codex: copy the
 * packaged local marketplace and return the registration commands as "instruction" actions (never
 * run). OpenCode: copy the plugin file into the OpenCode plugins directory. Files that differ and
 * were not written by Dynamic Skills are reported as "conflict" and left untouched unless `force`.
 */
export async function installNativeIntegration(input: NativeIntegrationInput): Promise<NativeIntegrationResult> {
  switch (input.harness) {
    case "claude":
      return { harness: input.harness, actions: await installClaude(input) };
    case "codex":
      return { harness: input.harness, actions: await installCodex(input) };
    case "opencode":
      return { harness: input.harness, actions: await installOpenCode(input) };
    default:
      throw dsError("configuration", "adapter", `Unknown harness: ${String(input.harness)}`, { recoverable: false });
  }
}
