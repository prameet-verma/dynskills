/**
 * §18.6 end-to-end tests inside a REAL Claude Code session (headless `claude -p`).
 *
 * Opt-in: these start real model sessions on your account, so they run only with
 *   DS_HARNESS_E2E=claude pnpm test:harness
 * Each test works in a throwaway repository; nothing outside it is written except Claude Code's
 * own session logs. Codex and OpenCode variants follow the same shape once those CLIs are installed.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RunStore } from "../../src/orchestrator/run-store.js";
import { TASK, makeRepo } from "../orchestrator/helpers.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ENABLED = (process.env.DS_HARNESS_E2E ?? "").split(",").includes("claude");
const HAS_CLAUDE = spawnSync("claude", ["--version"], { encoding: "utf8" }).status === 0;
const TIMEOUT = 10 * 60_000;

interface Env {
  root: string;
  bin: string;
}

async function prepare(): Promise<Env> {
  const { root } = await makeRepo();
  execFileSync("git", ["init", "-q"], { cwd: root });
  const bin = await mkdtemp(path.join(tmpdir(), "ds-bin-"));
  const shim = path.join(bin, "dynamic-skills");
  await writeFile(shim, `#!/bin/sh\nexec "${process.execPath}" "${path.join(ROOT, "dist/cli/index.js")}" "$@"\n`);
  await chmod(shim, 0o755);
  execFileSync(shim, ["init", "--harness", "claude", "--root", root], { encoding: "utf8" });
  await mkdir(path.join(root, ".claude"), { recursive: true });
  return { root, bin };
}

function claude(env: Env, prompt: string, extraTools: string[] = []): { code: number; result: string; raw: string } {
  const r = spawnSync(
    "claude",
    [
      "-p",
      prompt,
      "--output-format",
      "json",
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      "Bash(dynamic-skills *)",
      "Bash(command -v dynamic-skills)",
      "Read",
      "Write",
      "Skill",
      ...extraTools,
    ],
    {
      cwd: env.root,
      encoding: "utf8",
      timeout: TIMEOUT - 30_000,
      env: { ...process.env, PATH: `${env.bin}${path.delimiter}${process.env.PATH ?? ""}`, DYNAMIC_SKILLS_SESSION_ID: "sess_harness" },
    },
  );
  let result = r.stdout;
  try {
    result = String((JSON.parse(r.stdout) as { result?: unknown }).result ?? r.stdout);
  } catch {
    /* non-JSON output: keep raw */
  }
  return { code: r.status ?? -1, result, raw: `${r.stdout}\n${r.stderr}` };
}

describe.skipIf(!ENABLED || !HAS_CLAUDE)("Claude Code harness (real session)", () => {
  beforeAll(() => {
    execFileSync(process.execPath, [path.join(ROOT, "node_modules/typescript7/bin/tsc"), "-p", path.join(ROOT, "tsconfig.build.json")], { stdio: "inherit" });
  }, 120_000);

  it("installation + bootstrap discovery: the session lists the bootstrap skill", async () => {
    const env = await prepare();
    expect(existsSync(path.join(env.root, ".claude/skills/dynamic-skill-bootstrap/SKILL.md"))).toBe(true);
    const r = claude(env, "List the names of every skill available to you in this session, one per line, and nothing else.");
    expect(r.code, r.raw).toBe(0);
    expect(r.result).toContain("dynamic-skill-bootstrap");
  }, TIMEOUT);

  it("explicit invocation + runtime activation + project persistence", async () => {
    const env = await prepare();
    const r = claude(
      env,
      [
        `/dynamic-skill-bootstrap Task: ${TASK}.`,
        "The `dynamic-skills` command is already on PATH: run it directly, never through npx.",
        "Pass --force-generate to `run start`. Follow the protocol until the skill is active.",
        "Write every JSON input file under ./.ds-inputs/. Do not edit any other project file.",
        "When the protocol reaches persistence, choose project (I approve saving it in this project), then stop and print the skill name.",
      ].join(" "),
    );
    expect(r.code, r.raw).toBe(0);
    const runs = await new RunStore(env.root).list();
    const done = runs.find((x) => x.skill && x.state === "COMPLETED");
    expect(done, `runs: ${JSON.stringify(runs.map((x) => ({ state: x.state, error: x.error })))}\n${r.raw.slice(-2000)}`).toBeDefined();
    expect(done?.persistence?.choice).toBe("project");
    expect(existsSync(path.join(env.root, ".claude/skills", done?.skill?.name ?? "", "SKILL.md"))).toBe(true);
    expect(existsSync(path.join(env.root, ".dynamic-skills/bundles", done?.skill?.name ?? "", "bundle.json"))).toBe(true);
    expect(done?.metrics.activeMs ?? Infinity).toBeLessThanOrEqual(60_000);
  }, TIMEOUT);

  it("autonomous invocation: the agent chooses the bootstrap on its own for a specialised task", async () => {
    const env = await prepare();
    const r = claude(
      env,
      [
        `Task: ${TASK}.`,
        "(If you use Dynamic Skills, its `dynamic-skills` command is already on PATH; never run it through npx.)",
        "Before writing any code, make sure you have the project-specific expertise this needs, using the skills available to you.",
        "Write any JSON input files under ./.ds-inputs/ and do not edit project source files.",
        "If you are asked whether to keep a generated skill, choose discard. Stop once you would start editing source code.",
      ].join(" "),
    );
    expect(r.code, r.raw).toBe(0);
    const runs = await new RunStore(env.root).list();
    expect(runs.length, `the agent did not start a Dynamic Skills run on its own.\n${r.result.slice(-1500)}`).toBeGreaterThan(0);
  }, TIMEOUT);
});
