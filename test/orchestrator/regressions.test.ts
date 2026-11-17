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
