import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { DiscoveryEvidence, DiscoveryReport } from "../../src/contracts/index.js";
import { evidenceId } from "../../src/core/index.js";
import { fixture, scanFixture } from "./helpers.js";

const ALL = ["node-ts-monorepo", "python-project", "java-microservices", "go-service", "mixed-language", "conflicting-runtime", "minimal-docs", "extensive-instructions"];

const val = (e: DiscoveryEvidence) => (e.value ?? {}) as Record<string, unknown>;
const of = (r: DiscoveryReport, kind: DiscoveryEvidence["kind"]) => r.evidence.filter((e) => e.kind === kind);
const languages = (r: DiscoveryReport) => new Set(of(r, "language").map((e) => val(e).language));
const frameworks = (r: DiscoveryReport) => of(r, "framework").map((e) => ({ name: val(e).name, version: val(e).version, source: e.source }));
const managers = (r: DiscoveryReport) => new Set(of(r, "package_manager").map((e) => val(e).name));
const runtimes = (r: DiscoveryReport, runtime: string) => of(r, "runtime").filter((e) => val(e).runtime === runtime);

describe("deterministic discovery across fixtures", () => {
  it.each(ALL)("%s: evidence is traceable, well-formed and providers do not fail", async (name) => {
    const report = await scanFixture(name);
    const root = fixture(name);
    expect(report.evidence.length).toBeGreaterThan(0);
    for (const p of report.providers) expect(["ok", "skipped"], `${p.providerId}: ${p.error}`).toContain(p.status);
    const ids = new Set<string>();
    for (const e of report.evidence) {
      expect(existsSync(path.join(root, e.source)), `${e.source} exists`).toBe(true);
      expect(e.id).toBe(evidenceId(e.providerId, e.kind, e.source, e.claim));
      expect(ids.has(e.id)).toBe(false);
      ids.add(e.id);
      expect(e.confidence).toBeGreaterThan(0);
      expect(e.confidence).toBeLessThanOrEqual(1);
      if (e.excerpt) expect(e.excerpt.length).toBeLessThanOrEqual(200);
      expect(e.source).not.toMatch(/(^|\/)(node_modules|\.git|dist)\/|(^|\/)\.env/);
    }
  });

  it("is deterministic across runs", async () => {
    const a = await scanFixture("node-ts-monorepo");
    const b = await scanFixture("node-ts-monorepo");
    expect(b.evidence).toEqual(a.evidence);
  });

  it("node-ts-monorepo: TypeScript, pnpm workspaces, frameworks with versions, instructions, CI", async () => {
    const r = await scanFixture("node-ts-monorepo");
    expect(languages(r)).toContain("TypeScript");
    expect(frameworks(r)).toEqual(
      expect.arrayContaining([
        { name: "React", version: "18.3.1", source: "packages/web/package.json" },
        { name: "Express", version: "4.21.1", source: "packages/api/package.json" },
        { name: "Vitest", version: "2.1.4", source: "package.json" },
      ]),
    );
    const pm = of(r, "package_manager").find((e) => e.source === "package.json");
    expect(val(pm as DiscoveryEvidence)).toEqual({ name: "pnpm", version: "9.12.0" });
    expect(managers(r)).toEqual(new Set(["pnpm"]));
    const ws = of(r, "workspace");
    expect(ws.map((e) => val(e).path).filter(Boolean).sort()).toEqual(["packages/api", "packages/web"]);
    expect(ws.some((e) => e.source === "pnpm-workspace.yaml")).toBe(true);
    expect(ws.some((e) => val(e).tool === "turbo")).toBe(true);
    expect(new Set(runtimes(r, "node").map((e) => val(e).version))).toEqual(new Set([">=20", "20.11.1"]));
    expect(of(r, "instructions").map((e) => e.source)).toEqual(["CLAUDE.md"]);
    expect(of(r, "test_configuration").some((e) => e.source === "vitest.config.ts")).toBe(true);
    expect(of(r, "build_configuration").find((e) => e.source === "tsconfig.json")?.claim).toContain("strict");
    expect(of(r, "ci_cd").map((e) => e.source)).toEqual([".github/workflows/ci.yml"]);
    const src = of(r, "source_file");
    expect(src[0]).toBeDefined();
    const top = [...src].sort((a, b) => Number(val(b).score) - Number(val(a).score))[0] as DiscoveryEvidence;
    expect(top.source).toBe("packages/api/src/routes/payments.ts");
  });

  it("python-project: Python runtimes, FastAPI, pytest, uv", async () => {
    const r = await scanFixture("python-project", { description: "Return 404 for missing orders" });
    expect(languages(r)).toContain("Python");
    expect(new Set(runtimes(r, "python").map((e) => val(e).version))).toEqual(new Set([">=3.11", "3.12"]));
    const fw = frameworks(r).map((f) => f.name);
    expect(fw).toEqual(expect.arrayContaining(["FastAPI", "pytest", "Pydantic", "SQLAlchemy"]));
    expect(frameworks(r).find((f) => f.name === "FastAPI")?.version).toBe("0.115");
    expect(managers(r)).toContain("uv");
    expect(of(r, "test_configuration").some((e) => /tool\.pytest/.test(e.claim))).toBe(true);
    expect(of(r, "source_file").map((e) => e.source)).toContain("app/routers/orders.py");
  });

  it("java-microservices: Maven modules, Spring Boot, Java 21", async () => {
    const r = await scanFixture("java-microservices");
    expect(languages(r)).toContain("Java");
    expect(new Set(runtimes(r, "java").map((e) => val(e).version))).toEqual(new Set(["21"]));
    expect(frameworks(r).filter((f) => f.name === "Spring Boot").map((f) => f.version)).toEqual(["3.3.4", "3.3.4"]);
    expect(managers(r)).toEqual(new Set(["maven"]));
    expect(of(r, "workspace").map((e) => val(e).path).filter(Boolean).sort()).toEqual(["inventory-service", "order-service"]);
    expect(of(r, "entrypoint").length).toBe(2);
  });

  it("go-service: Go version, chi, go modules, Makefile", async () => {
    const r = await scanFixture("go-service", { description: "Add a readiness handler next to health" });
    expect(languages(r)).toContain("Go");
    expect(runtimes(r, "go").map((e) => val(e).version)).toEqual(["1.22"]);
    expect(frameworks(r)).toEqual(expect.arrayContaining([{ name: "chi", version: "5.1.0", source: "go.mod" }]));
    expect(managers(r)).toContain("go modules");
    expect(of(r, "build_configuration").find((e) => e.source === "Makefile")?.value).toMatchObject({ targets: ["build", "test", "lint"] });
    expect(of(r, "entrypoint").map((e) => e.source)).toContain("cmd/server/main.go");
    expect(of(r, "source_file").map((e) => e.source)).toContain("internal/handler/health.go");
  });

  it("mixed-language: three ecosystems in one repository", async () => {
    const r = await scanFixture("mixed-language");
    expect(languages(r)).toEqual(new Set(["TypeScript", "Python", "Go"]));
    expect(managers(r)).toEqual(new Set(["npm", "poetry", "go modules"]));
    const fw = frameworks(r);
    expect(fw).toEqual(
      expect.arrayContaining([
        { name: "React", version: "18.3.1", source: "frontend/package.json" },
        { name: "Flask", version: "3.0.3", source: "services/api/pyproject.toml" },
        { name: "Cobra", version: "1.8.1", source: "tools/cli/go.mod" },
      ]),
    );
    expect(runtimes(r, "go").map((e) => val(e).version)).toEqual(["1.23"]);
    expect(runtimes(r, "python").map((e) => val(e).version)).toEqual(["^3.11"]);
  });

  it("conflicting-runtime: surfaces three distinct Node.js runtime declarations", async () => {
    const r = await scanFixture("conflicting-runtime");
    const node = runtimes(r, "node");
    expect(node).toHaveLength(3);
    expect(new Set(node.map((e) => e.id)).size).toBe(3);
    expect(node.map((e) => [e.source, val(e).version]).sort()).toEqual([
      [".nvmrc", "18"],
      ["Dockerfile", "22"],
      ["package.json", ">=20"],
    ]);
    expect(node.every((e) => e.priority === "P0" && e.confidence === 1)).toBe(true);
  });

  it("minimal-docs: degrades gracefully with one source file and no docs", async () => {
    const r = await scanFixture("minimal-docs", { description: "Add a farewell greeting" });
    expect(r.fileIndexSize).toBe(1);
    expect(languages(r)).toEqual(new Set(["Python"]));
    expect(of(r, "documentation")).toHaveLength(0);
    expect(of(r, "instructions")).toHaveLength(0);
    expect(of(r, "entrypoint").map((e) => e.source)).toEqual(["main.py"]);
    expect(r.providers.find((p) => p.providerId === "documentation")?.status).toBe("skipped");
  });

  it("extensive-instructions: all instruction files and valid existing skills", async () => {
    const r = await scanFixture("extensive-instructions");
    expect(of(r, "instructions").map((e) => e.source).sort()).toEqual([".cursorrules", ".github/copilot-instructions.md", "AGENTS.md", "CLAUDE.md"]);
    expect(of(r, "instructions").every((e) => val(e).trusted === false)).toBe(true);
    const skills = of(r, "existing_skill");
    expect(skills.map((e) => [val(e).name, val(e).harness]).sort()).toEqual([
      ["changelog", "codex"],
      ["release-notes", "claude"],
    ]);
    expect(of(r, "documentation").map((e) => e.source)).toContain("docs/ARCHITECTURE.md");
    expect(of(r, "test_configuration").some((e) => e.source === "jest.config.js")).toBe(true);
  });

  it("orders evidence by priority, then kind, then source", async () => {
    const r = await scanFixture("node-ts-monorepo");
    const firstP1 = r.evidence.findIndex((e) => e.priority === "P1");
    expect(firstP1).toBeGreaterThan(0);
    expect(r.evidence.slice(firstP1).every((e) => e.priority !== "P0")).toBe(true);
  });
});
