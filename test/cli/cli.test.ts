import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FAKE_STRIPE_KEY, TASK, analysisFor, draftFor, makeRepo, readPacket } from "../orchestrator/helpers.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = path.join(ROOT, "dist/cli/index.js");

function cli(args: string[], opts: { root: string; home: string }): { code: number; stdout: string; stderr: string; json: () => Record<string, unknown> } {
  const r = spawnSync(process.execPath, [CLI, "--root", opts.root, "--home", opts.home, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: "", DYNAMIC_SKILLS_SESSION_ID: "sess_cli" },
  });
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr, json: () => JSON.parse(r.stdout) as Record<string, unknown> };
}

describe("dynamic-skills CLI (built)", () => {
  beforeAll(() => {
    execFileSync(process.execPath, [path.join(ROOT, "node_modules/typescript7/bin/tsc"), "-p", path.join(ROOT, "tsconfig.build.json")], { stdio: "inherit" });
  }, 120_000);

  it("init installs a discoverable bootstrap skill and doctor reports it", async () => {
    const env = await makeRepo();
    const init = cli(["init", "--harness", "claude,codex,opencode", "--json"], env);
    expect(init.code, init.stderr + init.stdout).toBe(0);
    for (const dir of [".claude/skills", ".agents/skills", ".opencode/skills"]) {
      expect(existsSync(path.join(env.root, dir, "dynamic-skill-bootstrap/SKILL.md"))).toBe(true);
    }
    expect(cli(["init", "--harness", "claude", "--json"], env).json().results).toMatchObject([{ status: "unchanged" }]);
    const doctor = cli(["doctor", "--json"], env).json();
    const checks = doctor.checks as Array<{ check: string; status: string }>;
    expect(checks.find((c) => c.check === "node")?.status).toBe("ok");
    expect(checks.find((c) => c.check === "bootstrap:claude")?.status).toBe("ok");
  });

  it("validate passes the bundled bootstrap skill", async () => {
    const env = await makeRepo();
    const r = cli(["validate", path.join(ROOT, "skills/dynamic-skill-bootstrap"), "--json"], env);
    expect(r.code, r.stdout).toBe(0);
    expect(["pass", "warning"]).toContain(r.json().status);
  });

  it("inspect prints a discovery profile without secrets", async () => {
    const env = await makeRepo();
    const r = cli(["inspect", "--json"], env);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).not.toContain(FAKE_STRIPE_KEY);
    expect(JSON.stringify(r.json().technology)).toMatch(/express/i);
  });

  it("drives a full bridge run through JSON files, then list and clean", async () => {
    const env = await makeRepo();
    const start = cli(["run", "start", "--harness", "claude", "--task", TASK], env);
    expect(start.code, start.stderr + start.stdout).toBe(0);
    const s = start.json();
    expect(s.status).toBe("awaiting_analysis");
    const runId = s.runId as string;
    const packet = await readPacket(s.packetPath as string);

    const analysisFile = path.join(env.home, "analysis.json");
    await writeFile(analysisFile, JSON.stringify(analysisFor(packet)));
    expect(cli(["run", "analyze", runId, "--input", analysisFile], env).json().status).toBe("awaiting_skill_draft");

    const draftFile = path.join(env.home, "draft.json");
    await writeFile(draftFile, JSON.stringify(draftFor(packet)));
    const compiled = cli(["run", "compile", runId, "--input", draftFile], env).json();
    expect(compiled.status, JSON.stringify(compiled)).toBe("active");

    expect(cli(["run", "status", runId], env).json().state).toBe("PERSISTENCE_PENDING");
    expect(cli(["run", "persist", runId, "--choice", "ephemeral"], env).json().status).toBe("completed");

    const list = cli(["list", "--json"], env).json();
    expect((list.runs as Array<{ name: string }>).map((r) => r.name)).toContain("stripe-refund-integration");

    const clean = cli(["clean", "--all", "--json"], env).json();
    expect(clean.removedInstalls).toContain("claude:stripe-refund-integration");
    expect(existsSync(path.join(env.root, ".claude/skills/stripe-refund-integration"))).toBe(false);
  });

  it("returns structured JSON errors for bad bridge calls", async () => {
    const env = await makeRepo();
    const r = cli(["run", "analyze", "run_doesnotexist", "--input", "-"], env);
    expect(r.code).toBe(2);
    expect(r.json()).toMatchObject({ status: "error", error: { category: "invalid_state" } });
  });
});
