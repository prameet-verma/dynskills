import { describe, it, expect } from "vitest";
import { mkdir, symlink, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import type { CanonicalBundleRecord, ContextFingerprint, LifecycleStatus } from "../../src/contracts/index.js";
import { DynamicSkillsError } from "../../src/core/index.js";
import {
  assessFreshness,
  computeContextFingerprint,
  findReusableBundles,
  LIFECYCLE_TRANSITIONS,
  nextSkillVersion,
  transitionLifecycle,
} from "../../src/lifecycle/index.js";
import { makeRecord, makeSkill, tmpDir } from "../storage/helpers.js";

async function repo(): Promise<string> {
  const root = await tmpDir("ds-life-");
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "package.json"), '{"name":"x"}');
  await writeFile(path.join(root, "src/api.ts"), "export const a = 1;");
  await writeFile(path.join(root, "src/db.ts"), "export const db = 1;");
  await writeFile(path.join(root, "tsconfig.json"), "{}");
  return root;
}

const FILES = ["package.json", "src/api.ts", "src/db.ts", "tsconfig.json"];
const FACTS = { "framework:react": "18.3.1", "runtime:node": "22.1.0", "packageManager": "pnpm", "language:typescript": "5.4.5" };

function recordWith(fp: ContextFingerprint, patch: Partial<CanonicalBundleRecord> = {}): CanonicalBundleRecord {
  const skill = makeSkill("api-review");
  return makeRecord(skill, { repositoryId: fp.repositoryId, contextFingerprint: fp, dependsOn: FILES, ...patch });
}

describe("computeContextFingerprint", () => {
  it("is stable and independent of input order", async () => {
    const root = await repo();
    const a = await computeContextFingerprint({ root, repositoryId: "repo_1", dependsOn: FILES, facts: FACTS });
    const b = await computeContextFingerprint({ root, repositoryId: "repo_1", dependsOn: [...FILES].reverse(), facts: { ...FACTS } });
    expect(a).toEqual(b);
    expect(a.components["fact:framework:react"]).toBe("18.3.1");
    expect(a.components["file:package.json"]).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(a.components)).toEqual([...Object.keys(a.components)].sort());
  });

  it("marks missing files and changes when content changes", async () => {
    const root = await repo();
    const a = await computeContextFingerprint({ root, repositoryId: "r", dependsOn: ["src/api.ts", "src/gone.ts"] });
    expect(a.components["file:src/gone.ts"]).toBe("missing");
    await writeFile(path.join(root, "src/api.ts"), "export const a = 2;");
    const b = await computeContextFingerprint({ root, repositoryId: "r", dependsOn: ["src/api.ts", "src/gone.ts"] });
    expect(b.overall).not.toBe(a.overall);
  });

  it("never reads outside root", async () => {
    const root = await repo();
    const outside = await tmpDir();
    await writeFile(path.join(outside, "secret.txt"), "s");
    await symlink(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
    await expect(computeContextFingerprint({ root, repositoryId: "r", dependsOn: ["../etc/passwd"] })).rejects.toThrow(DynamicSkillsError);
    await expect(computeContextFingerprint({ root, repositoryId: "r", dependsOn: ["link.txt"] })).rejects.toThrow(DynamicSkillsError);
  });
});

describe("assessFreshness", () => {
  it("reuses when the fingerprint is identical, even if the git revision changed", async () => {
    const root = await repo();
    const fp = await computeContextFingerprint({ root, repositoryId: "repo_1", dependsOn: FILES, facts: FACTS });
    // A new commit touching unrelated files does not change the relevant fingerprint.
    await writeFile(path.join(root, "README.md"), "new commit");
    const now = await computeContextFingerprint({ root, repositoryId: "repo_1", dependsOn: FILES, facts: FACTS });
    const d = assessFreshness(recordWith(fp), now);
    expect(d.decision).toBe("reuse");
    expect(d.changedComponents).toEqual([]);
  });

  it("regenerates for a different repository", async () => {
    const root = await repo();
    const fp = await computeContextFingerprint({ root, repositoryId: "repo_1", dependsOn: FILES, facts: FACTS });
    const d = assessFreshness(recordWith(fp), { ...fp, repositoryId: "repo_2" });
    expect(d.decision).toBe("regenerate");
    expect(d.reasons[0]).toMatch(/different repository/);
  });

  it("augments on a non-critical file change or a same-major fact change", async () => {
    const root = await repo();
    const fp = await computeContextFingerprint({ root, repositoryId: "repo_1", dependsOn: FILES, facts: FACTS });
    await writeFile(path.join(root, "src/api.ts"), "export const a = 3;");
    const now = await computeContextFingerprint({ root, repositoryId: "repo_1", dependsOn: FILES, facts: { ...FACTS, "framework:react": "18.4.0" } });
    const d = assessFreshness(recordWith(fp), now);
    expect(d.decision).toBe("augment");
    expect(d.changedComponents).toEqual(["fact:framework:react", "file:src/api.ts"]);
    expect(d.reasons.join(" ")).toMatch(/compatibly/);
  });

  it("regenerates when a critical file changes", async () => {
    const root = await repo();
    const fp = await computeContextFingerprint({ root, repositoryId: "repo_1", dependsOn: FILES, facts: FACTS });
    await writeFile(path.join(root, "src/db.ts"), "export const db = 2;");
    const now = await computeContextFingerprint({ root, repositoryId: "repo_1", dependsOn: FILES, facts: FACTS });
    expect(assessFreshness(recordWith(fp), now).decision).toBe("augment");
    expect(assessFreshness(recordWith(fp), now, { criticalFiles: ["src/db.ts"] }).decision).toBe("regenerate");
  });

  it("regenerates on a missing file, a major version change, or a removed fact", async () => {
    const root = await repo();
    const fp = await computeContextFingerprint({ root, repositoryId: "repo_1", dependsOn: FILES, facts: FACTS });
    await rm(path.join(root, "src/db.ts"));
    const missing = await computeContextFingerprint({ root, repositoryId: "repo_1", dependsOn: FILES, facts: FACTS });
    const d1 = assessFreshness(recordWith(fp), missing);
    expect(d1.decision).toBe("regenerate");
    expect(d1.reasons.join(" ")).toMatch(/missing/);

    const root2 = await repo();
    const fp2 = await computeContextFingerprint({ root: root2, repositoryId: "repo_1", dependsOn: FILES, facts: FACTS });
    const major = await computeContextFingerprint({ root: root2, repositoryId: "repo_1", dependsOn: FILES, facts: { ...FACTS, "framework:react": "19.0.0" } });
    expect(assessFreshness(recordWith(fp2), major).decision).toBe("regenerate");
    const minorBump = await computeContextFingerprint({ root: root2, repositoryId: "repo_1", dependsOn: FILES, facts: { ...FACTS, "runtime:node": "22.9.0" } });
    expect(assessFreshness(recordWith(fp2), minorBump).decision).toBe("augment");
    const zeroFp = await computeContextFingerprint({ root: root2, repositoryId: "repo_1", dependsOn: FILES, facts: { ...FACTS, "lib:zod": "0.3.1" } });
    const zeroMinor = await computeContextFingerprint({ root: root2, repositoryId: "repo_1", dependsOn: FILES, facts: { ...FACTS, "lib:zod": "0.4.0" } });
    expect(assessFreshness(recordWith(zeroFp), zeroMinor).decision).toBe("regenerate");
    const { ["framework:react"]: _removed, ...withoutReact } = FACTS;
    const removed = await computeContextFingerprint({ root: root2, repositoryId: "repo_1", dependsOn: FILES, facts: withoutReact });
    expect(assessFreshness(recordWith(fp2), removed).decision).toBe("regenerate");
    const pm = await computeContextFingerprint({ root: root2, repositoryId: "repo_1", dependsOn: FILES, facts: { ...FACTS, packageManager: "npm" } });
    expect(assessFreshness(recordWith(fp2), pm).decision).toBe("regenerate");
  });

  it("regenerates when more than half the components changed", async () => {
    const root = await repo();
    const fp = await computeContextFingerprint({ root, repositoryId: "repo_1", dependsOn: FILES });
    for (const f of ["package.json", "src/api.ts", "src/db.ts"]) await writeFile(path.join(root, f), `changed ${f}`);
    const now = await computeContextFingerprint({ root, repositoryId: "repo_1", dependsOn: FILES });
    const d = assessFreshness(recordWith(fp), now);
    expect(d.decision).toBe("regenerate");
    expect(d.reasons.join(" ")).toMatch(/3 of 4/);
  });

  it("does not reuse discarded/invalidated skills; wildcard personal bundles skip the repository check", async () => {
    const root = await repo();
    const fp = await computeContextFingerprint({ root, repositoryId: "repo_1", dependsOn: [] });
    expect(assessFreshness(recordWith(fp, { lifecycleStatus: "invalidated" }), fp).decision).toBe("regenerate");
    const generic = await computeContextFingerprint({ root, repositoryId: "*", dependsOn: [] });
    const elsewhere = await computeContextFingerprint({ root, repositoryId: "repo_9", dependsOn: [] });
    expect(assessFreshness(recordWith(generic, { repositoryId: "*" }), elsewhere).decision).toBe("reuse");
  });
});

describe("transitionLifecycle", () => {
  it("allows the documented transitions", () => {
    expect(transitionLifecycle("ephemeral", "active")).toBe("active");
    expect(transitionLifecycle("active", "persisted")).toBe("persisted");
    expect(transitionLifecycle("persisted", "invalidated")).toBe("invalidated");
    expect(transitionLifecycle("invalidated", "active")).toBe("active");
    expect(transitionLifecycle("expired", "discarded")).toBe("discarded");
    expect(transitionLifecycle("persisted", "persisted")).toBe("persisted");
  });

  it("throws invalid_state on illegal transitions", () => {
    const illegal: Array<[LifecycleStatus, LifecycleStatus]> = [
      ["ephemeral", "persisted"],
      ["expired", "active"],
      ["discarded", "active"],
      ["invalidated", "persisted"],
    ];
    for (const [from, to] of illegal) {
      try {
        transitionLifecycle(from, to);
        expect.fail(`${from} → ${to} should throw`);
      } catch (err) {
        expect(err).toBeInstanceOf(DynamicSkillsError);
        expect((err as DynamicSkillsError).info).toMatchObject({ category: "invalid_state", component: "lifecycle" });
      }
    }
    expect(LIFECYCLE_TRANSITIONS.discarded).toEqual([]);
  });
});

describe("nextSkillVersion", () => {
  it("bumps semver", () => {
    expect(nextSkillVersion(undefined, "patch")).toBe("1.0.0");
    expect(nextSkillVersion("1.2.3", "patch")).toBe("1.2.4");
    expect(nextSkillVersion("1.2.3", "minor")).toBe("1.3.0");
    expect(nextSkillVersion("1.2.3", "major")).toBe("2.0.0");
    expect(() => nextSkillVersion("banana", "patch")).toThrow(DynamicSkillsError);
  });
});

describe("findReusableBundles", () => {
  it("filters by repository and status and ranks by lexical relevance", () => {
    const mk = (name: string, task: string, patch: Partial<CanonicalBundleRecord> = {}) => makeRecord(makeSkill(name), { task, ...patch });
    const bundles = [
      mk("payment-webhook-review", "Review Stripe payment webhooks"),
      mk("payment-refunds", "Add refunds flow to checkout"),
      mk("docs-writer", "Write API docs"),
      mk("payment-other-repo", "payment webhooks", { repositoryId: "repo_other" }),
      mk("payment-discarded", "payment webhooks", { lifecycleStatus: "discarded" }),
      mk("payment-generic", "Generic payment webhook guidance", { repositoryId: "*" }),
    ];
    const found = findReusableBundles({ taskDescription: "Fix the payment webhook retries", bundles, repositoryId: "repo_test" });
    const names = found.map((b) => b.name);
    expect(names[0]).toBe("payment-webhook-review");
    expect(names).toContain("payment-generic");
    expect(names).toContain("payment-refunds");
    expect(names).not.toContain("docs-writer");
    expect(names).not.toContain("payment-other-repo");
    expect(names).not.toContain("payment-discarded");
    expect(findReusableBundles({ taskDescription: "the and for", bundles, repositoryId: "repo_test" })).toEqual([]);
  });
});
