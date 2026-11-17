import { describe, it, expect } from "vitest";
import { appendFile, readdir } from "node:fs/promises";
import path from "node:path";
import { Orchestrator } from "../../src/orchestrator/index.js";
import { resolveConfig } from "../../src/orchestrator/config.js";
import { DynamicSkillsError } from "../../src/core/index.js";
import type { ClarificationRequest } from "../../src/contracts/index.js";
import { TASK, analysisFor, draftFor, makeRepo, readPacket } from "./helpers.js";

async function setup(patch?: Parameters<typeof resolveConfig>[0]) {
  const { root, home } = await makeRepo();
  const orch = new Orchestrator({ root, harness: "claude", homeDir: home, sessionId: "sess_reg", env: { PATH: "" }, config: resolveConfig(patch) });
  return { root, orch };
}

describe("regressions found in the docs review", () => {
  it("clarification requests carry the configured round limit and the live round count", async () => {
    const { orch } = await setup({ execution: { maximumClarificationRounds: 2 } });
    const s = await orch.start({ task: { description: TASK } });
    const packet = await readPacket(s.packetPath as string);
    const a = await orch.analyze(s.runId, analysisFor(packet, { unknowns: [{ question: "Should refunds be partial, full, or both?", importance: "critical" }] }));
    expect(a.status).toBe("awaiting_clarification");
    expect((a.request as ClarificationRequest).maximumRounds).toBe(2);
    expect(a.budget.clarificationRoundsUsed).toBe(1);
  });

  it("tells the agent how to reload when the harness must rescan skills", async () => {
    const { orch } = await setup();
    const s = await orch.start({ task: { description: TASK } });
    const packet = await readPacket(s.packetPath as string);
    await orch.analyze(s.runId, analysisFor(packet));
    const c = await orch.compile(s.runId, { draft: draftFor(packet) });
    expect(c.requiresReload).toBe(true);
    expect(c.reloadInstruction).toMatch(/\/reload-skills/);
    expect(c.next).toMatch(/\/reload-skills/);
  });

  it("surfaces the real persist error instead of an illegal-transition error", async () => {
    const { orch } = await setup();
    const s = await orch.start({ task: { description: TASK } });
    const packet = await readPacket(s.packetPath as string);
    await orch.analyze(s.runId, analysisFor(packet));
    const c = await orch.compile(s.runId, { draft: draftFor(packet) });
    expect(c.status).toBe("active");
    const staged = path.join(path.dirname(s.packetPath as string), "skills", "stripe-refund-integration");
    expect(await readdir(staged)).toContain("SKILL.md");
    await appendFile(path.join(staged, "SKILL.md"), "\nInjected after evaluation.\n");
    const err = await orch.persist(s.runId, "project").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DynamicSkillsError);
    expect((err as DynamicSkillsError).info.category).toBe("security");
  });

  it("gives one consistent fallback when the repository changed", async () => {
    const { root, orch } = await setup();
    const s = await orch.start({ task: { description: TASK } });
    const packet = await readPacket(s.packetPath as string);
    await orch.analyze(s.runId, analysisFor(packet));
    await appendFile(path.join(root, "CLAUDE.md"), "\nchanged\n");
    const c = await orch.compile(s.runId, { draft: draftFor(packet) });
    expect(c.status).toBe("failed");
    expect(c.fallbackAction).toBeUndefined();
    expect((c.error as { fallbackAction: string; recoverable: boolean })).toMatchObject({ recoverable: true });
    expect((c.error as { fallbackAction: string }).fallbackAction).toMatch(/new run/);
  });

  it("rejects unknown values for enumerated settings", () => {
    expect(() => resolveConfig({ mode: "sometimes" as never })).toThrow(/"mode" must be one of/);
    expect(() => resolveConfig({ evaluation: { baselineComparison: "weekly" as never } })).toThrow(/baselineComparison/);
  });
});

describe("deterministic compile grounding and guidance (ADR-018)", () => {
  it("turns observed analysis facts into grounded constraints even when stated constraints don't echo them", async () => {
    const { orch } = await setup();
    const s = await orch.start({ task: { description: TASK } });
    const packet = await readPacket(s.packetPath as string);
    const analysis = analysisFor(packet, {
      // Task decisions whose wording matches no evidence: previously this left zero grounded constraints.
      taskContext: { relevantComponents: ["src/payments/gateway.ts"], existingImplementations: [], constraints: ["Refunds are full only for v1", "Skip partial captures"] },
      architecture: { patterns: [], moduleStructure: [], conventions: [], dependencies: [] },
      evidence: [
        { claim: "PaymentGateway wraps every Stripe call and maps failures with PaymentError.from", source: "src/payments/gateway.ts", type: "observed" },
        { claim: "routes.ts validates request bodies with zod schemas", source: "src/payments/routes.ts", type: "observed" },
        { claim: "Refund support likely belongs next to charge in the gateway", source: "src/payments/gateway.ts", type: "inferred" },
      ],
    });
    const a = await orch.analyze(s.runId, analysis);
    expect(a.status).toBe("awaiting_skill_draft");
    const c = await orch.compile(s.runId, { deterministic: true });
    expect(c.status, JSON.stringify(c.evaluation)).toBe("active");
    expect((c.evaluation as { checks: Record<string, string> }).checks.grounding).toBe("pass");
    expect(c.instructions).toMatch(/PaymentGateway wraps every Stripe call/);
    expect(c.instructions).toMatch(/- routes\.ts validates request bodies with zod schemas/); // file names keep their case
    expect(c.instructions).not.toMatch(/likely belongs next to charge/); // inferred claims are never constraints
  });

  it("tells the host how much budget is left and to prefer a draft", async () => {
    const { orch } = await setup();
    const s = await orch.start({ task: { description: TASK } });
    const packet = await readPacket(s.packetPath as string);
    const a = await orch.analyze(s.runId, analysisFor(packet));
    expect(a.next).toMatch(/\d+ s of the active budget remain, which is enough for a draft/);
    expect(a.next).toMatch(/--deterministic` only if fewer than 20 s remain/);
  });
});

describe("test commands (no test script, node:test)", () => {
  async function nodeTestRepo() {
    const { mkdtemp, mkdir: mk, writeFile: wf } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const root = await mkdtemp(path.join(tmpdir(), "ds-nodetest-"));
    const home = await mkdtemp(path.join(tmpdir(), "ds-nodetest-home-"));
    const files: Record<string, string> = {
      "package.json": JSON.stringify({ name: "ext", version: "1.0.0", dependencies: {} }),
      "package-lock.json": "{}",
      "content/inject.js": "export function handleRules(rules) { return rules; }\n",
      "test/inject.test.js": "// Run: node --test test/inject.test.js\nconst test = require('node:test');\ntest('rules', () => {});\n",
    };
    for (const [rel, content] of Object.entries(files)) {
      await mk(path.dirname(path.join(root, rel)), { recursive: true });
      await wf(path.join(root, rel), content);
    }
    return { root, orch: new Orchestrator({ root, harness: "claude", homeDir: home, sessionId: "sess_nt", env: { PATH: "" } }) };
  }
  const task = { description: "Wire the script engine into content/inject.js", scope: ["content/inject.js"] };

  it("discovers the missing test script and the node:test run command", async () => {
    const { orch } = await nodeTestRepo();
    const s = await orch.start({ task, forceGenerate: true });
    const claims = (await readPacket(s.packetPath as string)).evidence.map((e) => e.claim).join("\n");
    expect(claims).toMatch(/package\.json has no "test" script, so `npm test` fails/);
    expect(claims).toMatch(/Run command documented in inject\.test\.js: node --test test\/inject\.test\.js/);
    expect(claims).toMatch(/Node's built-in test runner \(node:test\)/);
  });

  it("deterministic skills use the discovered command, and drafts citing `npm test` must be revised", async () => {
    const { orch } = await nodeTestRepo();
    const s = await orch.start({ task, forceGenerate: true });
    const packet = await readPacket(s.packetPath as string);
    const ev = packet.evidence.find((e) => e.source === "content/inject.js")?.id ?? packet.evidence[0]?.id ?? "package.json";
    const analysis = analysisFor(packet, {
      technology: { languages: ["JavaScript"], frameworks: [], runtimes: ["node"], packageManagers: ["npm"] },
      architecture: { patterns: [], moduleStructure: ["content"], conventions: [], dependencies: [] },
      taskContext: { relevantComponents: ["content/inject.js"], existingImplementations: [], constraints: [] },
      evidence: [{ claim: "inject.js exports handleRules", source: "content/inject.js", type: "observed" }],
    });
    expect((await orch.analyze(s.runId, analysis)).status).toBe("awaiting_skill_draft");
    const bad = await orch.compile(s.runId, {
      draft: {
        ...draftFor(packet),
        name: "inject-script-bridge",
        description: "Wire the script engine into content/inject.js. Use when changing content/inject.js.",
        projectConstraints: [{ statement: "inject.js exports handleRules", evidence: [ev] }],
        verification: ["Run npm test and confirm tests pass"],
      },
    });
    expect(bad.status).toBe("revision_required");
    expect((bad.hints as string[]).join("\n")).toMatch(/`npm test` runs the "test" script, but package\.json has no such script/);

    const c = await orch.compile(s.runId, { deterministic: true });
    expect(c.status, JSON.stringify(c.evaluation)).toBe("active");
    expect(c.instructions).toMatch(/Run the tests with `node --test test\/inject\.test\.js`/);
    expect(c.instructions).not.toMatch(/npm test/);
  });
});
