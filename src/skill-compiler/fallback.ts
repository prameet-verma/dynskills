import type { ContextPacket, GroundedStatement, SkillCompilationRequest, SkillDraft } from "../contracts/index.js";
import { SCHEMA_VERSION } from "../contracts/index.js";
import { collectKnownReferences, findGroundingRefs } from "./grounding.js";
import { toSkillName, uniqueSkillName } from "./name.js";
import { capitalize, collapseWhitespace, significantWords, stripTrailingPunctuation, truncateAtWord } from "./text.js";

const MAX_NAME_WORDS = 5;
const MAX_CONSTRAINTS = 12;
const MAX_LISTED = 5;

const TEST_RUNNERS: Record<string, string | undefined> = {
  vitest: undefined,
  jest: undefined,
  mocha: undefined,
  ava: undefined,
  playwright: undefined,
  cypress: undefined,
  pytest: "pytest",
  unittest: "python -m unittest",
  "go test": "go test ./...",
  cargo: "cargo test",
  rspec: "bundle exec rspec",
  junit: undefined,
  phpunit: "vendor/bin/phpunit",
};
const LINTERS = ["eslint", "biome", "ruff", "flake8", "pylint", "golangci-lint", "clippy", "rubocop", "stylelint"];

function uniqCI(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const i = collapseWhitespace(raw);
    const k = i.toLowerCase();
    if (i.length === 0 || seen.has(k)) continue;
    seen.add(k);
    out.push(i);
  }
  return out;
}

/** Ensure terminal punctuation without doubling it ("Why?" stays "Why?", "Do x" → "Do x."). */
function sentence(text: string): string {
  const t = collapseWhitespace(text).replace(/[.;:,\s]+$/, "");
  return /[?!]$/.test(t) ? t : `${t}.`;
}

function joinList(items: readonly string[]): string {
  return items.map((i) => `\`${i}\``).join(", ");
}

function deriveVerification(request: SkillCompilationRequest, packet: ContextPacket): { verification: string[]; testTool?: string } {
  const a = request.context;
  const haystack = [
    ...packet.technology.tooling,
    ...a.architecture.dependencies,
    ...packet.evidence.filter((e) => e.kind === "test_configuration" || e.kind === "tooling").map((e) => e.claim),
  ]
    .join(" ")
    .toLowerCase();
  const pm = a.technology.packageManagers[0] ?? packet.technology.packageManagers[0];
  const testTool = Object.keys(TEST_RUNNERS).find((t) => new RegExp(`\\b${t}\\b`).test(haystack));
  const out: string[] = [];
  if (testTool) {
    const cmd = TEST_RUNNERS[testTool] ?? (pm ? `${pm} test` : undefined);
    out.push(
      cmd
        ? `Run the test suite (\`${cmd}\`; observed test tooling: ${testTool}) and confirm new and existing tests pass.`
        : `Run the ${testTool} test suite and confirm new and existing tests pass.`,
    );
  } else {
    out.push("Run the project's existing test command and confirm new and existing tests pass.");
  }
  const linter = LINTERS.find((l) => haystack.includes(l));
  if (linter) out.push(`Run ${linter} on the changed files with no new errors.`);
  const languages = [...a.technology.languages, ...packet.technology.languages].map((l) => l.toLowerCase());
  if (languages.includes("typescript")) out.push("Type-check the project (TypeScript) with no new errors.");
  out.push("Tests exercise the behaviour introduced or changed by the task.");
  return testTool !== undefined ? { verification: out, testTool } : { verification: out };
}

/**
 * Deterministic, no-LLM fallback compiler. Produces a minimal, grounded draft from the analysis
 * and packet; constraints that cannot be tied to known evidence are omitted.
 */
export function compileDeterministicDraft(request: SkillCompilationRequest, packet: ContextPacket): SkillDraft {
  const { task, context: a } = request;
  const taskText = stripTrailingPunctuation(collapseWhitespace(task.description));

  const taken = [...request.existingSkills.map((s) => s.name), ...packet.existingSkills.map((s) => s.name)];
  const name = uniqueSkillName(toSkillName(significantWords(taskText).slice(0, MAX_NAME_WORDS).join(" ")), taken);

  const language = a.technology.languages[0] ?? packet.technology.languages[0];
  const framework = a.technology.frameworks[0] ?? packet.technology.frameworks[0]?.name;
  const stack = uniqCI([framework, language].filter((x): x is string => x !== undefined && x !== "")).join(" / ");
  const components = uniqCI([...(task.scope ?? []), ...a.taskContext.relevantComponents]).slice(0, MAX_LISTED);
  const existingImpl = uniqCI(a.taskContext.existingImplementations).slice(0, 3);
  const patterns = uniqCI(a.architecture.patterns).slice(0, 3);
  const deps = uniqCI(a.architecture.dependencies).slice(0, MAX_LISTED);
  const expectedOutcome = task.expectedOutcome ?? a.taskContext.expectedOutcome;

  const description = truncateAtWord(
    `${capitalize(taskText)} in this ${stack ? `${stack} ` : ""}repository, following its observed conventions and verification steps. ` +
      `Use when working on this task${components.length > 0 ? ` or changing ${components.join(", ")}` : ""}.`,
    1024,
  );

  const { verification, testTool } = deriveVerification(request, packet);

  // Project constraints: only those that can be grounded in packet evidence.
  const known = collectKnownReferences(packet);
  const candidates = uniqCI([...a.taskContext.constraints, ...a.architecture.conventions]);
  const projectConstraints: GroundedStatement[] = [];
  for (const statement of candidates) {
    if (projectConstraints.length >= MAX_CONSTRAINTS) break;
    const evidence = findGroundingRefs(statement, a.evidence, packet.evidence, known);
    if (evidence.length > 0) projectConstraints.push({ statement: capitalize(sentence(statement)), evidence });
  }

  const scopePhrase = components.length > 0 ? components.join(", ") : "the task scope";
  const boundaries = [
    `Do not modify modules outside ${scopePhrase} unless the task cannot be completed otherwise; ask the root agent first.`,
    deps.length > 0
      ? `Do not add new dependencies when an existing one (${deps.join(", ")}) already covers the need.`
      : "Do not add new dependencies without a task-specific reason.",
    ...a.unknowns
      .filter((u) => u.importance === "critical")
      .slice(0, 3)
      .map((u) => `Do not assume an answer to: ${sentence(u.question)}`),
    ...a.conflicts.slice(0, 3).map((c) => `Do not resolve the conflict on ${c.subject} silently; surface it to the root agent.`),
  ];

  const workflow = [
    components.length > 0 || existingImpl.length > 0
      ? `Read ${joinList(uniqCI([...existingImpl, ...components]).slice(0, MAX_LISTED))} to confirm how the project currently handles this area.`
      : "Locate the code involved in the task and read the closest existing implementation.",
    "Check the planned change against each project constraint below before editing.",
    `Make the smallest change that delivers the task, reusing existing ${framework ? `${framework} ` : ""}patterns and utilities.`,
    `Add or update ${testTool ? `${testTool} ` : ""}tests for the changed behaviour.`,
    "Run the verification steps and fix failures before continuing.",
    "Report what changed, which constraints applied, and any assumptions to the root agent.",
  ];

  const assumptions = request.assumptions.map((x) => x.id);

  return {
    schemaVersion: SCHEMA_VERSION,
    runId: request.runId,
    name,
    description,
    specialist: {
      identity: `${stack ? `${stack} ` : ""}engineer for the "${truncateAtWord(taskText, 120)}" task`,
      responsibility: `Deliver "${taskText}" within this repository's established ${stack ? `${stack} ` : ""}architecture and conventions.`,
    },
    authority: {
      ownership: [
        components.length > 0 ? `Changes to ${components.join(", ")} required by the task.` : `The code changes required to ${taskText.charAt(0).toLowerCase()}${taskText.slice(1)}.`,
        "Tests covering the new or changed behaviour.",
      ],
      decisionRights: [
        "Implementation details inside the owned components, provided they satisfy the project constraints below.",
        ...(patterns.length > 0 ? [`How to apply the existing ${patterns.join(", ")} pattern(s) to this change.`] : []),
        ...(existingImpl.length > 0 ? [`Whether to extend an existing implementation (${existingImpl.join(", ")}) or add a new one alongside it.`] : []),
      ],
      boundaries,
      accountability: [
        ...(expectedOutcome ? [`The result meets the expected outcome: ${stripTrailingPunctuation(expectedOutcome)}.`] : []),
        "Every verification step below passes before the work is reported as complete.",
        ...(assumptions.length > 0 ? ["Each assumption listed below is stated explicitly in the final report."] : []),
      ],
    },
    workflow,
    projectConstraints,
    verification,
    ...(assumptions.length > 0 ? { assumptions } : {}),
  };
}
