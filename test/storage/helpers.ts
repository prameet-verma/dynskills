import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CanonicalBundleRecord, GeneratedSkill, SkillEvaluationReport, SkillFile } from "../../src/contracts/index.js";
import { hashSkillFiles } from "../../src/core/index.js";

export async function tmpDir(prefix = "ds-test-"): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

export function skillMd(name: string, body = "Follow the repository conventions.", opts: { marker?: boolean; description?: string } = {}): string {
  const meta = opts.marker === false ? "" : `metadata:\n  dynamic-skills.generator: "0.1.0"\n`;
  return `---\nname: ${name}\ndescription: ${opts.description ?? `Use when working on ${name}.`}\n${meta}---\n\n# ${name}\n\n${body}\n`;
}

export function makeSkill(name: string, body?: string, extra: SkillFile[] = []): GeneratedSkill {
  const files: SkillFile[] = [{ path: "SKILL.md", content: skillMd(name, body) }, ...extra];
  const artifactHash = hashSkillFiles(files);
  return {
    skillId: `${name}@${artifactHash.slice(0, 12)}`,
    name,
    description: `Use when working on ${name}.`,
    files,
    artifactHash,
    tokenCount: 50,
    provenance: {
      runId: "run_test",
      repositoryId: "repo_test",
      generatorVersion: "0.1.0",
      skillVersion: "1.0.0",
      contextFingerprint: "fp",
      evidenceIds: [],
      assumptionIds: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  };
}

export function makeRecord(skill: GeneratedSkill, patch: Partial<CanonicalBundleRecord> = {}): CanonicalBundleRecord {
  return {
    skillId: skill.skillId,
    name: skill.name,
    artifactHash: skill.artifactHash,
    skillVersion: "1.0.0",
    generatorVersion: "0.1.0",
    repositoryId: "repo_test",
    contextFingerprint: { repositoryId: "repo_test", overall: "x", components: {} },
    evaluation: {} as SkillEvaluationReport,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lifecycleStatus: "persisted",
    installs: [],
    dependsOn: [],
    task: `Work on ${skill.name}`,
    ...patch,
  };
}
