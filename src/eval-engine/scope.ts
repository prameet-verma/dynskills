import type { EvalFinding, EvalResult, GeneratedSkill } from "../contracts/index.js";
import { coverage, keywordSet } from "../skill-compiler/index.js";
import type { EvalContext } from "./context.js";
import { SKILL_FILE, info, parsedSkill, runCheck, skillMd, warning } from "./context.js";

/** Minimum share of task keywords that should appear in the SKILL.md body. */
export const SCOPE_BODY_COVERAGE_MIN = 0.3;

/**
 * Well-known libraries/frameworks/services. If SKILL.md mentions one that never appears in the
 * task or analysis, it is likely irrelevant (§7.6).
 */
export const KNOWN_DEPENDENCIES: readonly string[] = [
  "react", "vue", "angular", "svelte", "next.js", "nextjs", "nuxt", "remix", "astro", "solid",
  "express", "fastify", "koa", "hapi", "nestjs", "django", "flask", "fastapi", "rails", "laravel", "spring", "gin",
  "prisma", "typeorm", "sequelize", "mongoose", "drizzle", "sqlalchemy", "knex",
  "redux", "mobx", "zustand", "graphql", "apollo", "trpc", "tailwind", "bootstrap",
  "jest", "vitest", "mocha", "jasmine", "cypress", "playwright", "pytest", "rspec",
  "webpack", "vite", "rollup", "esbuild", "babel", "parcel",
  "kafka", "rabbitmq", "redis", "postgres", "postgresql", "mysql", "mongodb", "sqlite", "dynamodb", "elasticsearch",
  "docker", "kubernetes", "terraform", "lodash", "axios", "stripe", "firebase", "supabase",
];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentions(text: string, dep: string): boolean {
  return new RegExp(`(^|[^a-z0-9@/-])${escapeRe(dep)}($|[^a-z0-9-])`, "i").test(text);
}

function scopeFindings(skill: GeneratedSkill, ctx: EvalContext): EvalFinding[] {
  const f: EvalFinding[] = [];
  const parsed = parsedSkill(skill);
  const content = skillMd(skill) ?? "";
  const taskText = [ctx.task.description, ...(ctx.task.scope ?? []), ctx.task.expectedOutcome ?? ""].join(" ");
  const taskKw = keywordSet(taskText);

  const descCoverage = coverage(taskKw, keywordSet(skill.description));
  if (taskKw.size > 0 && descCoverage === 0) {
    f.push(warning("description_off_task", "The description shares no keywords with the task; say what the skill does for this task and when to use it.", SKILL_FILE));
  }
  if (!/\b(use|when|for)\b/i.test(skill.description)) {
    f.push(warning("description_no_trigger", "The description should say when to use the skill (e.g. \"Use when …\").", SKILL_FILE));
  }
  const bodyCoverage = coverage(taskKw, keywordSet(parsed?.body ?? content));
  if (taskKw.size > 0 && bodyCoverage < SCOPE_BODY_COVERAGE_MIN) {
    f.push(
      warning(
        "body_off_task",
        `Only ${Math.round(bodyCoverage * 100)}% of the task's keywords appear in SKILL.md (expected ≥ ${SCOPE_BODY_COVERAGE_MIN * 100}%); focus the instructions on the task.`,
        SKILL_FILE,
      ),
    );
  }

  // Irrelevant dependencies: mentioned in the skill but absent from task + analysis.
  const contextText = [
    JSON.stringify(ctx.analysis),
    JSON.stringify(ctx.task),
    JSON.stringify([...ctx.knownPaths]),
    JSON.stringify(ctx.evidenceClaims ?? []),
  ].join(" ");
  const irrelevant = KNOWN_DEPENDENCIES.filter((d) => mentions(content, d) && !mentions(contextText, d));
  for (const m of content.matchAll(/\b(?:npm (?:install|i)|pnpm add|yarn add|bun add|pip install|poetry add|cargo add|go get|gem install)\s+((?:-{1,2}\S+\s+)*)([@\w./-]+)/g)) {
    const pkg = m[2] ?? "";
    if (pkg && !contextText.toLowerCase().includes(pkg.toLowerCase()) && !irrelevant.includes(pkg)) irrelevant.push(pkg);
  }
  if (irrelevant.length > 0) {
    f.push(
      warning(
        "irrelevant_dependency",
        `SKILL.md mentions dependencies not found in the analysed context: ${irrelevant.join(", ")}. Remove them unless the task needs them.`,
        SKILL_FILE,
      ),
    );
  }
  if (f.length === 0) f.push(info("scope_ok", `Task keyword coverage: description ${Math.round(descCoverage * 100)}%, body ${Math.round(bodyCoverage * 100)}%.`));
  return f;
}

/** Not mandatory: task relevance (keyword overlap) and irrelevant dependency detection. Warnings only. */
export function checkScope(skill: GeneratedSkill, ctx: EvalContext): EvalResult {
  return runCheck("scope", false, () => scopeFindings(skill, ctx));
}
