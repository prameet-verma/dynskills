import { stringify as stringifyYaml } from "yaml";
import type { Assumption, GeneratedSkill, SkillDraft, SkillFile } from "../contracts/index.js";
import { GENERATOR_VERSION, METADATA_NAMESPACE, estimateTokens, hashSkillFiles } from "../core/index.js";
import { SECTION, formatEvidenceRefs, sanitizeInline } from "./markdown.js";
import { safeReferenceFileName, titleCaseName } from "./name.js";
import { collapseWhitespace } from "./text.js";

export const DEFAULT_SKILL_VERSION = "1.0.0";

export const METADATA_KEYS = {
  runId: `${METADATA_NAMESPACE}.run-id`,
  generatorVersion: `${METADATA_NAMESPACE}.generator-version`,
  skillVersion: `${METADATA_NAMESPACE}.skill-version`,
  contextFingerprint: `${METADATA_NAMESPACE}.context-fingerprint`,
} as const;

export interface RenderContext {
  repositoryId: string;
  contextFingerprint: string;
  /** Extra packet evidence ids to record in provenance (unioned with ids cited by constraints). */
  evidenceIds?: string[];
  /** Default "1.0.0". */
  skillVersion?: string;
  /** Provenance createdAt (does not affect file content or hash). */
  now?: Date;
  /** Assumption records, used to render statements next to assumption ids. */
  assumptions?: Assumption[];
}

function uniq(items: readonly string[]): string[] {
  return [...new Set(items)];
}

function bullets(items: readonly string[]): string[] {
  return items.map((i) => sanitizeInline(i)).filter((i) => i.length > 0).map((i) => `- ${i}`);
}

function firstSentence(text: string): string {
  const flat = collapseWhitespace(text);
  const m = /^(.+?[.!?])(\s|$)/.exec(flat);
  return m?.[1] ?? flat;
}

function isAssumptionRef(ref: string, assumptionIds: ReadonlySet<string>): boolean {
  return assumptionIds.has(ref) || ref.startsWith("asm_");
}

/** Render a draft into a canonical Agent Skills artifact (deterministic: same input → same bytes). */
export function renderSkill(draft: SkillDraft, ctx: RenderContext): GeneratedSkill {
  const name = draft.name;
  const description = collapseWhitespace(draft.description);
  const skillVersion = ctx.skillVersion ?? DEFAULT_SKILL_VERSION;
  const draftAssumptionIds = uniq((draft.assumptions ?? []).map((a) => a.trim()).filter((a) => a.length > 0));
  const knownAssumptionIds = new Set([...draftAssumptionIds, ...(ctx.assumptions ?? []).map((a) => a.id)]);

  const references = (draft.references ?? [])
    .map((r) => ({ fileName: safeReferenceFileName(r.fileName), title: sanitizeInline(r.title), content: r.content }))
    .filter((r, i, all) => all.findIndex((o) => o.fileName === r.fileName) === i);

  const frontmatter = {
    name,
    description,
    metadata: {
      [METADATA_KEYS.runId]: draft.runId,
      [METADATA_KEYS.generatorVersion]: GENERATOR_VERSION,
      [METADATA_KEYS.skillVersion]: skillVersion,
      [METADATA_KEYS.contextFingerprint]: ctx.contextFingerprint,
    },
  };
  const yamlText = stringifyYaml(frontmatter, { lineWidth: 0 }).trimEnd();

  const lines: string[] = ["---", yamlText, "---", "", `# ${titleCaseName(name)}`, "", firstSentence(description), ""];

  lines.push(`## ${SECTION.role}`, "");
  lines.push(`You are the **${sanitizeInline(draft.specialist.identity)}**. ${sanitizeInline(draft.specialist.responsibility)}`, "");

  lines.push(`## ${SECTION.authority}`, "");
  const authority: Array<[string, string[]]> = [
    [SECTION.ownership, draft.authority.ownership],
    [SECTION.decisionRights, draft.authority.decisionRights],
    [SECTION.boundaries, draft.authority.boundaries],
    [SECTION.accountability, draft.authority.accountability],
  ];
  for (const [heading, items] of authority) {
    lines.push(`### ${heading}`, "", ...bullets(items), "");
  }

  lines.push(`## ${SECTION.workflow}`, "");
  draft.workflow
    .map((s) => sanitizeInline(s))
    .filter((s) => s.length > 0)
    .forEach((step, i) => lines.push(`${i + 1}. ${step}`));
  lines.push("");

  const citedEvidence: string[] = [];
  const citedAssumptions: string[] = [];
  const constraintLines: string[] = [];
  for (const c of draft.projectConstraints) {
    const statement = sanitizeInline(c.statement);
    if (statement.length === 0) continue;
    const refs = uniq(c.evidence.map((e) => e.trim()).filter((e) => e.length > 0 && !/[,<]/.test(e)));
    for (const r of refs) {
      if (r.startsWith("ev_")) citedEvidence.push(r);
      else if (isAssumptionRef(r, knownAssumptionIds)) citedAssumptions.push(r);
    }
    constraintLines.push(refs.length > 0 ? `- ${statement} ${formatEvidenceRefs(refs)}` : `- ${statement}`);
  }
  if (constraintLines.length > 0) lines.push(`## ${SECTION.projectConstraints}`, "", ...constraintLines, "");

  lines.push(`## ${SECTION.verification}`, "", ...bullets(draft.verification), "");

  if (draftAssumptionIds.length > 0) {
    const statements = new Map((ctx.assumptions ?? []).map((a) => [a.id, a.statement]));
    lines.push(`## ${SECTION.assumptions}`, "");
    for (const id of draftAssumptionIds) {
      const st = statements.get(id);
      lines.push(st ? `- \`${id}\`: ${sanitizeInline(st)}` : `- \`${id}\``);
    }
    lines.push("");
  }

  if (references.length > 0) {
    lines.push(`## ${SECTION.references}`, "");
    for (const r of references) lines.push(`- [${r.title || r.fileName}](references/${r.fileName})`);
    lines.push("");
  }

  const skillMd = `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
  const files: SkillFile[] = [{ path: "SKILL.md", content: skillMd }];
  for (const r of references) {
    const body = r.content.replace(/\r\n?/g, "\n").trim();
    const content = body.startsWith("#") ? `${body}\n` : `# ${r.title || r.fileName}\n\n${body}\n`;
    files.push({ path: `references/${r.fileName}`, content });
  }

  const artifactHash = hashSkillFiles(files);
  return {
    skillId: `${name}@${artifactHash.slice(0, 12)}`,
    name,
    description,
    files,
    artifactHash,
    tokenCount: estimateTokens(skillMd),
    provenance: {
      runId: draft.runId,
      repositoryId: ctx.repositoryId,
      generatorVersion: GENERATOR_VERSION,
      skillVersion,
      contextFingerprint: ctx.contextFingerprint,
      evidenceIds: uniq([...(ctx.evidenceIds ?? []), ...citedEvidence]).sort(),
      assumptionIds: uniq([...draftAssumptionIds, ...citedAssumptions]).sort(),
      createdAt: (ctx.now ?? new Date()).toISOString(),
    },
  };
}
