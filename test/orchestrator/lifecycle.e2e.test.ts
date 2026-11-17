import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Orchestrator } from "../../src/orchestrator/index.js";
import { resolveConfig } from "../../src/orchestrator/config.js";
import { ArtifactStore, readSkillDir } from "../../src/storage/index.js";
import { compareWithBaseline, createBehaviouralEvalCase } from "../../src/eval-engine/index.js";
import { hashSkillFiles } from "../../src/core/index.js";
import type { BaselineComparison, GeneratedSkill, HarnessId } from "../../src/contracts/index.js";
import { TASK, analysisFor, draftFor, makeRepo, readPacket } from "./helpers.js";

const SKILL = "stripe-refund-integration";

async function setup(opts: { harness?: HarnessId; baseline?: "promotion-only" | "always" | "never" } = {}) {
  const { root, home } = await makeRepo();
  const config = resolveConfig(opts.baseline ? { evaluation: { baselineComparison: opts.baseline } } : undefined);
  const orch = new Orchestrator({ root, harness: opts.harness ?? "claude", homeDir: home, sessionId: "sess_life", env: { PATH: "" }, config });
  return { root, home, orch };
}

/** start → analyze → compile with the standard host draft. */
async function generate(orch: Orchestrator, before?: (packetPath: string) => Promise<void>) {
  const s = await orch.start({ task: { description: TASK } });
  expect(s.status).toBe("awaiting_analysis");
  const packet = await readPacket(s.packetPath as string);
  const a = await orch.analyze(s.runId, analysisFor(packet));
  expect(a.status).toBe("awaiting_skill_draft");
  await before?.(s.packetPath as string);
  const c = await orch.compile(s.runId, { draft: draftFor(packet) });
  return { start: s, compile: c, runId: s.runId };
}

describe("§17 repository changes during generation", () => {
  it("refuses to activate when a file the skill relies on changed", async () => {
    const { root, orch } = await setup();
    const { compile, runId } = await generate(orch, () => appendFile(path.join(root, "CLAUDE.md"), "\nRefunds must be idempotent.\n"));
    expect(compile.status).toBe("failed");
    expect((compile.error as { category: string }).category).toBe("repository_changed");
    expect(compile.changedFiles).toContain("CLAUDE.md");
    expect(existsSync(path.join(root, ".claude/skills", SKILL))).toBe(false);
    expect((await orch.status(runId)).state).toBe("FAILED");
  });

  it("activates, but reports, when only files the skill does not rely on changed", async () => {
    const { root, orch } = await setup();
    let touched: string | undefined;
    const { compile } = await generate(orch, async (packetPath) => {
      const packet = await readPacket(packetPath);
      touched = packet.sourceFiles.map((f) => f.path).find((p) => p !== "src/payments/gateway.ts");
      if (touched) await appendFile(path.join(root, touched), "\n// touched\n");
    });
    expect(compile.status).toBe("active");
    expect(touched, "packet should include a task-relevant source file the skill does not cite").toBeDefined();
    expect((compile.repositoryChanges as { uncited: string[] }).uncited).toContain(touched);
  });
});

describe("§10.6 stale skills are revised with a version bump", () => {
  it("augments a saved skill whose manifest changed, keeps history, and replaces it only on persist", async () => {
    const { root, orch } = await setup();
    const first = await generate(orch);
    expect(first.compile.status).toBe("active");
    const p1 = await orch.persist(first.runId, "project");
    expect(p1.skillVersion).toBe("1.0.0");
    const installed = path.join(root, ".claude/skills", SKILL);
    const v1Hash = hashSkillFiles(await readSkillDir(installed));

    // The project changes: a new dependency lands in package.json.
    const pkgPath = path.join(root, "package.json");
    const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
    pkg.dependencies["p-retry"] = "6.2.0";
    await writeFile(pkgPath, JSON.stringify(pkg, null, 2));

    const second = await orch.start({ task: { description: TASK } });
    expect(second.status).toBe("awaiting_analysis");
    const revision = second.revision as { name: string; decision: string; previousVersion: string; nextVersion: string };
    expect(revision).toMatchObject({ name: SKILL, previousVersion: "1.0.0" });
    expect(["augment", "regenerate"]).toContain(revision.decision);
    expect(revision.nextVersion).toBe(revision.decision === "augment" ? "1.1.0" : "2.0.0");

    const packet = await readPacket(second.packetPath as string);
    await orch.analyze(second.runId, analysisFor(packet));
    const prompt = await readFile(path.join(path.dirname(second.packetPath as string), "compile-prompt.md"), "utf8");
    expect(prompt).toContain("Revision of an existing skill");

    const c = await orch.compile(second.runId, { draft: draftFor(packet, { name: "something-else" }) });
    expect(c.status, JSON.stringify(c.evaluation)).toBe("active");
    expect((c.skill as { name: string }).name).toBe(SKILL);
    expect(c.instructions).toContain(`dynamic-skills.skill-version: ${revision.nextVersion}`);
    // The saved copy is untouched until the user approves the revision.
    expect(hashSkillFiles(await readSkillDir(installed))).toBe(v1Hash);

    const p2 = await orch.persist(second.runId, "project");
    expect(p2.status).toBe("completed");
    expect(p2.skillVersion).toBe(revision.nextVersion);
    expect(await readFile(path.join(installed, "SKILL.md"), "utf8")).toContain(`skill-version: ${revision.nextVersion}`);
    const bundle = await new ArtifactStore({ projectRoot: root }).loadBundle(SKILL, "project");
    expect(bundle?.record.skillVersion).toBe(revision.nextVersion);
    expect(bundle?.record.history?.[0]).toMatchObject({ skillVersion: "1.0.0", artifactHash: v1Hash });

    // Unchanged repository → the revised skill is reused as is.
    const third = await orch.start({ task: { description: TASK } });
    expect(third.status).toBe("reuse_existing");
  });

  it("leaves the saved version in place when a revision is discarded", async () => {
    const { root, orch } = await setup();
    const first = await generate(orch);
    await orch.persist(first.runId, "project");
    const installed = path.join(root, ".claude/skills", SKILL);
    const v1Hash = hashSkillFiles(await readSkillDir(installed));
    await appendFile(path.join(root, "CLAUDE.md"), "\nAll refunds are logged.\n");

    const second = await orch.start({ task: { description: TASK } });
    expect(second.revision).toBeDefined();
    const packet = await readPacket(second.packetPath as string);
    await orch.analyze(second.runId, analysisFor(packet));
    expect((await orch.compile(second.runId, { draft: draftFor(packet) })).status).toBe("active");
    const d = await orch.persist(second.runId, "discard");
    expect(d.next).toMatch(/saved version is unchanged/);
    expect(hashSkillFiles(await readSkillDir(installed))).toBe(v1Hash);
  });
});

describe("§10.5 identical installs across harnesses", () => {
  it("installs byte-identical copies into every chosen harness and records them", async () => {
    const { root, orch } = await setup();
    const { runId, compile } = await generate(orch);
    expect(compile.status).toBe("active");
    const p = await orch.persist(runId, "project", { harnesses: ["codex", "opencode"] });
    expect(p.status, JSON.stringify(p)).toBe("completed");
    const dirs = [".claude/skills", ".agents/skills", ".opencode/skills"].map((d) => path.join(root, d, SKILL));
    const hashes = await Promise.all(dirs.map(async (d) => hashSkillFiles(await readSkillDir(d))));
    expect(new Set(hashes).size).toBe(1);
    const bundle = await new ArtifactStore({ projectRoot: root }).loadBundle(SKILL, "project");
    expect(bundle?.record.installs.map((i) => i.harness).sort()).toEqual(["claude", "codex", "opencode"]);
    expect(bundle?.files && hashSkillFiles(bundle.files)).toBe(hashes[0]);
  });
});

describe("§8.3 baseline comparison", () => {
  it("records a baseline on promotion, and none when disabled", async () => {
    const on = await setup();
    const a = await generate(on.orch);
    const pa = await on.orch.persist(a.runId, "project");
    const baseline = pa.baseline as BaselineComparison;
    expect(baseline.trigger).toBe("promotion");
    expect(baseline.skillCoverage).toBeGreaterThanOrEqual(baseline.baselineCoverage);
    const bundle = await new ArtifactStore({ projectRoot: on.root }).loadBundle(SKILL, "project");
    expect(bundle?.record.baseline?.caseId).toBe(baseline.caseId);

    const off = await setup({ baseline: "never" });
    const b = await generate(off.orch);
    expect((await off.orch.persist(b.runId, "project")).baseline).toBeUndefined();
  });

  it("judges lift against the repository's own instructions", () => {
    const skillMd = "---\nname: x\ndescription: d\n---\n# X\n## Workflow\n1. Add a refund method to PaymentGateway wrapping stripe refunds.\n2. Map provider errors with PaymentError.\n3. Add vitest tests for refund failures.\n### Boundaries\n- Do not call the Stripe SDK outside the gateway.\n";
    const skill = { skillId: "x@1", name: "x", description: "d", files: [{ path: "SKILL.md", content: skillMd }], artifactHash: "h", tokenCount: 50, provenance: {} } as unknown as GeneratedSkill;
    const evalCase = {
      id: "case",
      task: "refunds",
      expectedActions: ["Add a refund method to PaymentGateway", "Map provider errors with PaymentError", "Add vitest tests for refund failures"],
      prohibitedActions: ["Call the Stripe SDK outside the gateway"],
      expectedOutcome: "refunds work",
    };
    const better = compareWithBaseline({ skill, evalCase, baselineTexts: ["All payment calls go through the gateway."], trigger: "promotion" });
    expect(better.verdict).toBe("improves");
    expect(better.lift).toBeGreaterThan(0);
    const same = compareWithBaseline({ skill, evalCase, baselineTexts: [skillMd], trigger: "promotion" });
    expect(same.verdict).toBe("no_improvement");
    expect(same.lift).toBe(0);
    expect(createBehaviouralEvalCase).toBeTypeOf("function");
  });
});
