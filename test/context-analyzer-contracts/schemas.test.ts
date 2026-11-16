import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import Ajv2020Module from "ajv/dist/2020.js";
import { loadSchema, schemaPath, SCHEMA_NAMES, type SchemaName } from "../../src/context-analyzer-contracts/index.js";
import { analysis, clarificationResponse, contextRequest, packet, skillDraft } from "./fixtures.js";

type Ajv2020Class = typeof Ajv2020Module.default;
const Ajv2020 = ((Ajv2020Module as unknown as { default?: Ajv2020Class }).default ?? (Ajv2020Module as unknown as Ajv2020Class)) as Ajv2020Class;

const EXAMPLES: Record<SchemaName, () => unknown> = {
  "context-packet": () => packet(),
  "context-analysis-result": () => analysis(),
  "skill-draft": () => skillDraft(),
  "clarification-response": () => clarificationResponse(),
  "context-request": () => contextRequest(),
};

describe("published JSON schemas", () => {
  it.each(SCHEMA_NAMES)("%s compiles with Ajv 2020 (strict) and has a stable $id", (name) => {
    const file = schemaPath(name);
    expect(path.isAbsolute(file)).toBe(true);
    expect(existsSync(file)).toBe(true);
    const schema = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.$id).toBe(`https://dynamic-skills.dev/schemas/${name}.schema.json`);
    expect(typeof schema.description).toBe("string");
    expect(schema.additionalProperties).toBe(false);
    const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
    expect(() => ajv.compile(schema)).not.toThrow();
  });

  it.each(SCHEMA_NAMES)("a hand-written valid %s example validates (schema ↔ TS contract in sync)", (name) => {
    const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
    const validate = ajv.compile(loadSchema(name));
    const ok = validate(EXAMPLES[name]());
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it("minimal examples (optional fields omitted) also validate", () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
    const a = analysis();
    delete a.additionalContextRequests;
    delete a.taskContext.expectedOutcome;
    expect(ajv.compile(loadSchema("context-analysis-result"))(a)).toBe(true);
    const d = skillDraft();
    delete d.assumptions;
    delete d.references;
    expect(ajv.compile(loadSchema("skill-draft"))(d)).toBe(true);
    expect(ajv.compile(loadSchema("context-request"))({ type: "dependency_details", query: "stripe", reason: "r", priority: "optional" })).toBe(true);
  });

  it("the ContextRequest definition embedded in the analysis schema matches context-request.schema.json", () => {
    const standalone = loadSchema("context-request") as Record<string, unknown>;
    const embedded = (loadSchema("context-analysis-result") as { $defs: Record<string, Record<string, unknown>> }).$defs.contextRequest!;
    const strip = (s: Record<string, unknown>): unknown =>
      JSON.parse(JSON.stringify(s, (k, v: unknown) => (k === "description" || k === "$schema" || k === "$id" || k === "title" ? undefined : v)));
    expect(strip(embedded)).toEqual(strip(standalone));
  });

  it("loadSchema returns an independent copy", () => {
    const a = loadSchema("skill-draft") as Record<string, unknown>;
    a.title = "mutated";
    expect((loadSchema("skill-draft") as Record<string, unknown>).title).toBe("SkillDraft");
  });

  it("rejects unknown schema names", () => {
    expect(() => schemaPath("nope" as SchemaName)).toThrow();
  });
});
