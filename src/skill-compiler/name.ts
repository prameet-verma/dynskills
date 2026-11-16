/** Agent Skills `name` rules: 1–64 chars, lowercase a-z/0-9 and single hyphens, no leading/trailing hyphen. */
export const SKILL_NAME_MAX_LENGTH = 64;
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const FALLBACK_SKILL_NAME = "project-specialist";

export function isValidSkillName(name: string): boolean {
  return name.length >= 1 && name.length <= SKILL_NAME_MAX_LENGTH && SKILL_NAME_PATTERN.test(name);
}

function clampName(name: string, max: number): string {
  if (name.length <= max) return name;
  const cut = name.slice(0, max);
  const hyphen = cut.lastIndexOf("-");
  const out = hyphen >= Math.floor(max / 2) ? cut.slice(0, hyphen) : cut;
  return out.replace(/-+$/, "");
}

/** Lowercase kebab-case, ≤ 64 chars, spec-valid, never empty (fallback "project-specialist"). */
export function toSkillName(text: string): string {
  const kebab = text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const clamped = clampName(kebab, SKILL_NAME_MAX_LENGTH);
  return clamped.length > 0 ? clamped : FALLBACK_SKILL_NAME;
}

/** Returns `name`, or `name-2`, `name-3`, … so that it does not collide (case-insensitively) with `taken`. */
export function uniqueSkillName(name: string, taken: Iterable<string>): string {
  const lower = new Set([...taken].map((t) => t.toLowerCase()));
  const base = toSkillName(name);
  if (!lower.has(base)) return base;
  for (let i = 2; ; i++) {
    const suffix = `-${i}`;
    const candidate = `${clampName(base, SKILL_NAME_MAX_LENGTH - suffix.length)}${suffix}`;
    if (!lower.has(candidate)) return candidate;
  }
}

/** "payment-integration-review" → "Payment Integration Review". */
export function titleCaseName(name: string): string {
  return name
    .split("-")
    .filter((p) => p.length > 0)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}

/** Safe reference file basename: kebab-case with a `.md` extension (no directories, no traversal). */
export function safeReferenceFileName(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? "";
  const stemPart = base.replace(/\.[A-Za-z0-9]+$/, "");
  return `${toSkillName(stemPart === "" ? "reference" : stemPart)}.md`;
}
