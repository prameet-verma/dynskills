import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ContextPacket, ContextRequest, DiscoveryLimits, DiscoveryReport, TaskIntent } from "../../src/contracts/index.js";
import { estimateTokens } from "../../src/core/index.js";
import { applyContextRequests, buildContextPacket, DEFAULT_DISCOVERY_LIMITS, serializePacket } from "../../src/context-packet/index.js";
import { buildFileIndex, RepositoryScanner } from "../../src/discovery/index.js";
import { fixture, fixtureCopyWithExclusions, LIMITS, TASK, tmpDir } from "../discovery/helpers.js";

async function packetFor(root: string, task: TaskIntent = TASK, limits: DiscoveryLimits = LIMITS): Promise<{ packet: ContextPacket; report: DiscoveryReport }> {
  const report = await new RepositoryScanner().scan({ root, task, limits });
  const packet = await buildContextPacket({ runId: "run_test", task, root, repository: { repositoryId: "repo_x", workingDirectory: root }, report, limits });
  return { packet, report };
}

function contentEntries(p: ContextPacket): string[] {
  return [...p.instructions.flatMap((i) => (i.content !== undefined ? [i.content] : [])), ...p.configuration.flatMap((c) => (c.content !== undefined ? [c.content] : [])), ...p.sourceFiles.map((s) => s.content)];
}

describe("buildContextPacket", () => {
  it("defaults follow §5.3", () => {
    expect(DEFAULT_DISCOVERY_LIMITS).toMatchObject({ maxFiles: 30, maxFileBytes: 64 * 1024, maxTotalBytes: 512 * 1024, contextTokenBudget: 12_000 });
  });

  it("consolidates technology, structure, instructions, configuration and task-relevant sources", async () => {
    const { packet, report } = await packetFor(fixture("node-ts-monorepo"));
    expect(packet.schemaVersion).toBe("1.0");
    expect(packet.repository).toMatchObject({ repositoryId: "repo_x" });
    expect(packet.technology.languages[0]).toBe("TypeScript");
    expect(packet.technology.packageManagers).toEqual(["pnpm"]);
    expect(packet.technology.frameworks).toEqual(expect.arrayContaining([{ name: "Express", version: "4.21.1", source: "packages/api/package.json" }]));
    expect(packet.technology.runtimes.node).toContain("20.11.1");
    expect(packet.structure.workspaces).toEqual(["packages/api", "packages/web"]);
    expect(packet.structure.relevantDirectories[0]).toBe("packages/api/src/routes");
    expect(packet.instructions).toEqual([{ path: "CLAUDE.md", content: expect.stringContaining("Use pnpm") }]);
    expect(packet.configuration.find((c) => c.path === "package.json")?.content).toContain("acme-monorepo");
    expect(packet.sourceFiles[0]).toMatchObject({ path: "packages/api/src/routes/payments.ts", truncated: false, reason: expect.stringContaining("payment") });
    expect(packet.evidence).toHaveLength(report.evidence.length);
    expect(packet.estimatedTokens).toBe(estimateTokens(serializePacket(packet)));
    expect(packet.estimatedTokens).toBeLessThanOrEqual(LIMITS.contextTokenBudget);
    expect(packet.discoveryLimits.filesRead).toBe(contentEntries(packet).length);
  });

  it("surfaces conflicting runtimes in the packet", async () => {
    const { packet } = await packetFor(fixture("conflicting-runtime"));
    expect(packet.technology.runtimes.node).toBe("18 (.nvmrc) | 22 (Dockerfile) | >=20 (package.json)");
  });

  it("lists existing skills and all instruction files", async () => {
    const { packet } = await packetFor(fixture("extensive-instructions"));
    expect(packet.existingSkills.map((s) => s.name).sort()).toEqual(["changelog", "release-notes"]);
    expect(packet.instructions.map((i) => i.path)).toEqual(["CLAUDE.md", "AGENTS.md", ".cursorrules", ".github/copilot-instructions.md"]);
    expect(packet.instructions.every((i) => typeof i.content === "string" && i.content.length > 0)).toBe(true);
  });

  it("never includes sensitive files or excluded directories, and redacts secrets", async () => {
    const root = await fixtureCopyWithExclusions("node-ts-monorepo");
    await writeFile(path.join(root, "packages/api/src/payments-client.ts"), 'export const token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij12";\nexport const url = "postgres://admin:hunter2@db/payments";\n');
    const { packet } = await packetFor(root);
    const json = serializePacket(packet);
    const paths = [
      ...packet.instructions.map((i) => i.path),
      ...packet.configuration.map((c) => c.path),
      ...packet.sourceFiles.map((s) => s.path),
      ...packet.evidence.map((e) => e.source),
    ];
    for (const p of paths) expect(p).not.toMatch(/(^|\/)(node_modules|dist)(\/|$)|(^|\/)\.env|\.pem$/);
    expect(json).not.toContain("FAKE-local-secret");
    expect(json).not.toContain("BEGIN FAKE");
    expect(json).not.toContain("FAKE-not-a-real-secret");
    expect(json).not.toContain("FAKE_api_key_value_for_tests_0000");
    expect(json).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij12");
    expect(json).not.toContain("hunter2");
    expect(packet.sourceFiles.find((s) => s.path === "packages/api/src/config.ts")?.content).toContain("[REDACTED]");
    expect(packet.sourceFiles.find((s) => s.path === "packages/api/src/payments-client.ts")?.content).toMatch(/token = "\[REDACTED/);
  });

  it("enforces file, byte and token limits on a large repository without dropping P0 evidence", async () => {
    const root = await tmpDir("ds-big-");
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "big", dependencies: { express: "^4.0.0" } }));
    await writeFile(path.join(root, "CLAUDE.md"), `# Rules\n${"- Always validate payment input before processing.\n".repeat(4000)}`);
    await mkdir(path.join(root, "src/payments"), { recursive: true });
    for (let i = 0; i < 60; i++) {
      await writeFile(path.join(root, `src/payments/payment-${String(i).padStart(2, "0")}.ts`), `export const payment${i} = ${JSON.stringify("x".repeat(60))};\n`.repeat(400));
    }
    const limits: DiscoveryLimits = { ...LIMITS, maxFiles: 8, maxFileBytes: 4096, maxTotalBytes: 16_000, contextTokenBudget: 6_000 };
    const task = { description: "Refactor payment processing" };
    const { packet, report } = await packetFor(root, task, limits);
    const contents = contentEntries(packet);
    expect(contents.length).toBeGreaterThan(1);
    expect(contents.length).toBeLessThanOrEqual(limits.maxFiles);
    for (const c of contents) expect(Buffer.byteLength(c)).toBeLessThanOrEqual(limits.maxFileBytes);
    expect(contents.reduce((n, c) => n + Buffer.byteLength(c), 0)).toBeLessThanOrEqual(limits.maxTotalBytes);
    expect(estimateTokens(serializePacket(packet))).toBeLessThanOrEqual(limits.contextTokenBudget);
    expect(packet.estimatedTokens).toBeLessThanOrEqual(limits.contextTokenBudget);
    expect(packet.discoveryLimits.truncated).toBe(true);
    expect(packet.discoveryLimits.reasons.length).toBeGreaterThan(0);
    expect(packet.discoveryLimits.filesSkipped).toBeGreaterThan(0);
    const p0 = report.evidence.filter((e) => e.priority === "P0").map((e) => e.id);
    const kept = new Set(packet.evidence.map((e) => e.id));
    expect(p0.every((id) => kept.has(id))).toBe(true);
    // Task relevance first: the instruction file is truncated, not allowed to starve source excerpts.
    expect(packet.sourceFiles.length).toBeGreaterThan(0);
    expect(packet.instructions[0]?.content?.length ?? 0).toBeLessThan(200_000);
  });

  it("keeps every P0 evidence entry even when they alone exceed a tiny budget", async () => {
    const tiny: DiscoveryLimits = { ...LIMITS, contextTokenBudget: 1_500 };
    const { packet, report } = await packetFor(fixture("node-ts-monorepo"), TASK, tiny);
    const p0 = report.evidence.filter((e) => e.priority === "P0");
    expect(packet.evidence.filter((e) => e.priority === "P0").map((e) => e.id)).toEqual(p0.map((e) => e.id));
    expect(packet.evidence.some((e) => e.priority !== "P0")).toBe(false);
    expect(packet.sourceFiles).toHaveLength(0);
    expect(packet.discoveryLimits.truncated).toBe(true);
    expect(packet.discoveryLimits.reasons.join("\n")).toMatch(/P0 evidence/);
  });

  it("serializePacket is stable regardless of key insertion order", async () => {
    const { packet } = await packetFor(fixture("go-service"));
    const shuffled = Object.fromEntries(Object.entries(packet).reverse()) as unknown as ContextPacket;
    expect(serializePacket(shuffled)).toBe(serializePacket(packet));
  });
});

describe("applyContextRequests", () => {
  it("rejects traversal, absolute, sensitive and excluded paths; fulfils a valid request without mutating input", async () => {
    const root = await fixtureCopyWithExclusions("node-ts-monorepo");
    const { packet } = await packetFor(root);
    const before = structuredClone(packet);
    const req = (p: string, type: ContextRequest["type"] = "source_file", priority: ContextRequest["priority"] = "optional"): ContextRequest => ({ type, path: p, reason: "test", priority });
    const requests = [req("../outside.txt"), req("packages/../../etc/passwd"), req("/etc/passwd"), req(".env"), req("config/.env.local", "configuration"), req("node_modules/left-pad/index.js"), req("packages/web/src/App.tsx", "source_file", "required")];
    const result = await applyContextRequests({ packet, requests, root, limits: LIMITS });

    expect(packet).toEqual(before);
    expect(result.packet).not.toBe(packet);
    expect(result.fulfilled.map((r) => r.path)).toEqual(["packages/web/src/App.tsx"]);
    const reasons = Object.fromEntries(result.rejected.map((r) => [r.request.path, r.reason]));
    expect(reasons["../outside.txt"]).toMatch(/traversal/);
    expect(reasons["packages/../../etc/passwd"]).toMatch(/traversal/);
    expect(reasons["/etc/passwd"]).toMatch(/absolute/);
    expect(reasons[".env"]).toMatch(/sensitive/);
    expect(reasons["config/.env.local"]).toMatch(/sensitive/);
    expect(reasons["node_modules/left-pad/index.js"]).toMatch(/excluded/);
    const added = result.packet.sourceFiles.find((s) => s.path === "packages/web/src/App.tsx");
    expect(added?.content).toContain("Acme payments");
    expect(added?.reason).toMatch(/^requested \(required\)/);
    expect(result.packet.evidence.some((e) => e.providerId === "context-request" && e.source === "packages/web/src/App.tsx")).toBe(true);
    expect(result.packet.discoveryLimits.filesRead).toBe(packet.discoveryLimits.filesRead + 1);
    expect(result.packet.estimatedTokens).toBe(estimateTokens(serializePacket(result.packet)));
    expect(result.packet.estimatedTokens).toBeLessThanOrEqual(LIMITS.contextTokenBudget);
  });

  it("supports query, directory_summary and dependency_details requests with a bounded file index", async () => {
    const root = fixture("node-ts-monorepo");
    const { packet } = await packetFor(root, { description: "Polish the web App component" });
    const fileIndex = await buildFileIndex(root);
    const result = await applyContextRequests({
      packet,
      root,
      limits: LIMITS,
      fileIndex,
      requests: [
        { type: "source_file", query: "payments route", reason: "see existing route", priority: "optional" },
        { type: "directory_summary", path: "packages/api", reason: "layout", priority: "optional" },
        { type: "dependency_details", query: "express", reason: "version", priority: "required" },
        { type: "dependency_details", query: "left-pad-not-there", reason: "version", priority: "optional" },
        { type: "documentation", query: "nothing-matches-this", reason: "docs", priority: "optional" },
        { type: "configuration", reason: "no path or query", priority: "optional" },
      ],
    });
    expect(result.fulfilled.map((r) => r.type)).toEqual(["dependency_details", "source_file", "directory_summary"]);
    expect(result.rejected).toHaveLength(3);
    expect(result.packet.sourceFiles.some((s) => s.path === "packages/api/src/routes/payments.ts")).toBe(true);
    expect(result.packet.configuration.find((c) => c.path === "packages/api")?.summary).toMatch(/files/);
    expect(result.packet.structure.relevantDirectories).toContain("packages/api");
    expect(result.packet.configuration.find((c) => c.path === "packages/api/package.json")?.summary ?? result.packet.evidence.find((e) => e.claim.startsWith("Dependency express"))?.claim).toMatch(/express/);
  });

  it("makes room for required requests by evicting unrequested excerpts, staying within budget", async () => {
    const root = fixture("node-ts-monorepo");
    const limits: DiscoveryLimits = { ...LIMITS, contextTokenBudget: 4_000 };
    const { packet } = await packetFor(root, TASK, limits);
    const result = await applyContextRequests({
      packet,
      root,
      limits,
      requests: [{ type: "source_file", path: "packages/web/src/main.tsx", reason: "entry point", priority: "required" }],
    });
    expect(result.fulfilled).toHaveLength(1);
    expect(result.packet.sourceFiles.some((s) => s.path === "packages/web/src/main.tsx")).toBe(true);
    expect(estimateTokens(serializePacket(result.packet))).toBeLessThanOrEqual(limits.contextTokenBudget);
  });

  it("respects maxFiles: optional requests are rejected, required ones evict an unrequested excerpt", async () => {
    const root = fixture("node-ts-monorepo");
    const { packet } = await packetFor(root);
    const limits: DiscoveryLimits = { ...LIMITS, maxFiles: contentEntries(packet).length };
    const result = await applyContextRequests({
      packet,
      root,
      limits,
      requests: [
        { type: "source_file", path: "packages/web/src/App.tsx", reason: "optional look", priority: "optional" },
        { type: "source_file", path: "packages/web/src/main.tsx", reason: "must see", priority: "required" },
      ],
    });
    expect(result.fulfilled.map((r) => r.path)).toEqual(["packages/web/src/main.tsx"]);
    expect(result.rejected[0]?.reason).toMatch(/maxFiles/);
    expect(contentEntries(result.packet).length).toBeLessThanOrEqual(limits.maxFiles);
  });
});
