import { parse as parseYaml } from "yaml";

/**
 * SKILL.md parsing helpers shared by the renderer and the eval engine.
 *
 * Evidence-reference format (rendered by renderSkill, parsed by the grounding eval): every
 * bullet in `## Project constraints` ends with
 *
 *     <sub>evidence: ev_abc123def456, src/app.ts, asm_1a2b3c</sub>
 *
 * i.e. the literal `<sub>evidence: `, a comma-separated list of references (packet evidence ids,
 * repository-relative paths, or assumption ids), then `</sub>` at the end of the line.
 * References therefore must not contain `,` or `<`.
 */

export const SECTION = {
  role: "Role",
  authority: "Authority",
  ownership: "Ownership",
  decisionRights: "Decision rights",
  boundaries: "Boundaries",
  accountability: "Accountability",
  workflow: "Workflow",
  projectConstraints: "Project constraints",
  verification: "Verification",
  assumptions: "Assumptions",
  references: "References",
} as const;

export const EVIDENCE_REF_PREFIX = "<sub>evidence: ";
export const EVIDENCE_REF_SUFFIX = "</sub>";
const EVIDENCE_REF_REGEX = /<sub>\s*evidence:\s*([^<]*)<\/sub>\s*$/i;

export function formatEvidenceRefs(refs: readonly string[]): string {
  return `${EVIDENCE_REF_PREFIX}${refs.join(", ")}${EVIDENCE_REF_SUFFIX}`;
}

/** Evidence refs at the end of a line, or undefined when the line has no evidence marker. */
export function parseEvidenceRefs(line: string): string[] | undefined {
  const m = EVIDENCE_REF_REGEX.exec(line);
  if (!m) return undefined;
  return (m[1] ?? "")
    .split(",")
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
}

/** Make a single-line item safe to render next to an evidence marker. */
export function sanitizeInline(text: string): string {
  return text
    .replace(/<\/?sub>/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

export interface ParsedSkillMarkdown {
  frontmatter: Record<string, unknown> | undefined;
  body: string;
  error?: string;
  /** Machine-readable error kind (set together with `error`). */
  errorKind?: "missing" | "unclosed" | "invalid_yaml" | "not_mapping";
}

/** Split SKILL.md into YAML frontmatter (parsed) and Markdown body. Never throws. */
export function parseSkillMarkdown(content: string): ParsedSkillMarkdown {
  const text = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") {
    return { frontmatter: undefined, body: text, error: "SKILL.md must start with a YAML frontmatter block delimited by '---'.", errorKind: "missing" };
  }
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      close = i;
      break;
    }
  }
  if (close === -1) {
    return { frontmatter: undefined, body: text, error: "SKILL.md frontmatter is not closed with '---'.", errorKind: "unclosed" };
  }
  const yamlText = lines.slice(1, close).join("\n");
  const body = lines.slice(close + 1).join("\n");
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText);
  } catch (err) {
    const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
    return { frontmatter: undefined, body, error: `Frontmatter is not valid YAML: ${msg}`, errorKind: "invalid_yaml" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { frontmatter: undefined, body, error: "Frontmatter must be a YAML mapping.", errorKind: "not_mapping" };
  }
  return { frontmatter: parsed as Record<string, unknown>, body };
}

export interface AnnotatedLine {
  /** 0-based index within the body. */
  index: number;
  text: string;
  /** Current `## ` heading text (undefined before the first one). */
  h2?: string;
  /** Current `### ` heading text within the h2. */
  h3?: string;
  isHeading: boolean;
  inFence: boolean;
}

/** Annotate body lines with the section they belong to (headings inside code fences are ignored). */
export function annotateLines(body: string): AnnotatedLine[] {
  const out: AnnotatedLine[] = [];
  let h2: string | undefined;
  let h3: string | undefined;
  let inFence = false;
  body.split("\n").forEach((text, index) => {
    if (/^\s*(```|~~~)/.test(text)) {
      inFence = !inFence;
      out.push({ index, text, ...(h2 !== undefined ? { h2 } : {}), ...(h3 !== undefined ? { h3 } : {}), isHeading: false, inFence: true });
      return;
    }
    let isHeading = false;
    if (!inFence) {
      const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(text);
      if (m) {
        isHeading = true;
        const level = (m[1] ?? "").length;
        const title = m[2] ?? "";
        if (level <= 1) {
          h2 = undefined;
          h3 = undefined;
        } else if (level === 2) {
          h2 = title;
          h3 = undefined;
        } else if (level === 3) {
          h3 = title;
        }
      }
    }
    out.push({ index, text, ...(h2 !== undefined ? { h2 } : {}), ...(h3 !== undefined ? { h3 } : {}), isHeading, inFence });
  });
  return out;
}

function same(a: string | undefined, b: string): boolean {
  return a !== undefined && a.trim().toLowerCase() === b.toLowerCase();
}

/** Non-heading lines under `## h2` (and optionally `### h3`). */
export function sectionLines(body: string, h2: string, h3?: string): string[] {
  return annotateLines(body)
    .filter((l) => !l.isHeading && same(l.h2, h2) && (h3 === undefined || same(l.h3, h3)))
    .map((l) => l.text);
}

export function hasSection(body: string, h2: string): boolean {
  return annotateLines(body).some((l) => l.isHeading && same(l.h2, h2) && l.h3 === undefined);
}

/** Top-level list items (`- `, `* `, `1. `) of a set of lines, with the marker removed. */
export function bulletItems(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const m = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (m) out.push((m[1] ?? "").trim());
  }
  return out;
}

export function isBoundaryLine(line: AnnotatedLine): boolean {
  return same(line.h3, SECTION.boundaries);
}

/** Relative Markdown link targets in `text` (external URLs and pure anchors excluded). */
export function relativeLinks(text: string): string[] {
  const out: string[] = [];
  const re = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
  for (const m of text.matchAll(re)) {
    const target = m[1] ?? "";
    if (target === "" || target.startsWith("#")) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // http:, https:, mailto:, etc.
    out.push(target.split("#")[0] ?? target);
  }
  return out;
}
