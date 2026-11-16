import { access, constants, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { HarnessId } from "../contracts/index.js";
import { HARNESS_IDS } from "../contracts/index.js";

async function isDir(p: string): Promise<boolean> {
  return (await stat(p).catch(() => undefined))?.isDirectory() ?? false;
}

async function isFile(p: string): Promise<boolean> {
  return (await stat(p).catch(() => undefined))?.isFile() ?? false;
}

/** True when an executable named `binary` exists on PATH. Scans PATH entries directly (no shell). */
export async function isOnPath(binary: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (!binary || binary.includes("/") || binary.includes("\\")) return false;
  const pathVar = env.PATH ?? env.Path ?? "";
  const exts = process.platform === "win32" ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)] : [""];
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, binary + ext);
      if (!(await isFile(candidate))) continue;
      if (process.platform === "win32") return true;
      const executable = await access(candidate, constants.X_OK).then(
        () => true,
        () => false,
      );
      if (executable) return true;
    }
  }
  return false;
}

/** CLI binary name per harness. */
export const HARNESS_BINARIES: Readonly<Record<HarnessId, string>> = {
  claude: "claude",
  codex: "codex",
  opencode: "opencode",
};

interface Marker {
  kind: "dir" | "file";
  base: "project" | "home";
  rel: string;
}

const HARNESS_MARKERS: Readonly<Record<HarnessId, Marker[]>> = {
  claude: [
    { kind: "dir", base: "project", rel: ".claude" },
    { kind: "dir", base: "home", rel: ".claude" },
  ],
  codex: [
    { kind: "dir", base: "project", rel: ".codex" },
    { kind: "dir", base: "home", rel: ".codex" },
    { kind: "dir", base: "project", rel: ".agents" },
  ],
  opencode: [
    { kind: "dir", base: "project", rel: ".opencode" },
    { kind: "file", base: "project", rel: "opencode.json" },
    { kind: "dir", base: "home", rel: path.join(".config", "opencode") },
  ],
};

/** Detect installed/configured harnesses from PATH binaries and project/home config locations. */
export async function detectHarnesses(opts: {
  projectRoot: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<Array<{ id: HarnessId; reasons: string[] }>> {
  const home = path.resolve(opts.homeDir ?? homedir());
  const project = path.resolve(opts.projectRoot);
  const env = opts.env ?? process.env;
  const found: Array<{ id: HarnessId; reasons: string[] }> = [];
  for (const id of HARNESS_IDS) {
    const reasons: string[] = [];
    const bin = HARNESS_BINARIES[id];
    if (await isOnPath(bin, env)) reasons.push(`\`${bin}\` found on PATH`);
    for (const m of HARNESS_MARKERS[id]) {
      const abs = path.join(m.base === "project" ? project : home, m.rel);
      const present = m.kind === "dir" ? await isDir(abs) : await isFile(abs);
      if (present) reasons.push(`${m.base === "project" ? "project" : "home"} ${m.kind === "dir" ? "directory" : "file"} ${m.base === "project" ? m.rel : `~/${m.rel}`} exists`);
    }
    if (reasons.length > 0) found.push({ id, reasons });
  }
  return found;
}
