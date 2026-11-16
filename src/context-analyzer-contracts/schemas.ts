import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020Module from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";
import type { ValidationIssue } from "../contracts/index.js";
import { dsError } from "../core/index.js";

export type SchemaName =
  | "context-packet"
  | "context-analysis-result"
  | "skill-draft"
  | "clarification-response"
  | "context-request";

export const SCHEMA_NAMES: readonly SchemaName[] = [
  "context-packet",
  "context-analysis-result",
  "skill-draft",
  "clarification-response",
  "context-request",
];

// ajv ships CommonJS; under `module: nodenext` the default import is `module.exports`,
// which is the Ajv2020 class itself at runtime but typed as the module namespace.
type Ajv2020Class = typeof Ajv2020Module.default;
const Ajv2020 = ((Ajv2020Module as unknown as { default?: Ajv2020Class }).default ??
  (Ajv2020Module as unknown as Ajv2020Class)) as Ajv2020Class;

/**
 * Absolute path of a published schema file. Resolved relative to this module so it works from
 * both `src/context-analyzer-contracts/` and `dist/context-analyzer-contracts/` (the package ships `schemas/`).
 */
export function schemaPath(name: SchemaName): string {
  assertSchemaName(name);
  return fileURLToPath(new URL(`../../schemas/${name}.schema.json`, import.meta.url));
}

const rawCache = new Map<SchemaName, Record<string, unknown>>();

function readSchema(name: SchemaName): Record<string, unknown> {
  let schema = rawCache.get(name);
  if (!schema) {
    try {
      schema = JSON.parse(readFileSync(schemaPath(name), "utf8")) as Record<string, unknown>;
    } catch (cause) {
      throw dsError("configuration", "context-analyzer", `Cannot load schema "${name}" from ${schemaPath(name)}`, {
        cause,
        fallbackAction: "Reinstall Dynamic Skills; the published schemas/ directory is missing or corrupt.",
      });
    }
    rawCache.set(name, schema);
  }
  return schema;
}

/** Parsed JSON Schema document (a fresh copy; mutations do not affect validation). */
export function loadSchema(name: SchemaName): object {
  return structuredClone(readSchema(name));
}

let ajv: InstanceType<Ajv2020Class> | undefined;
const compiled = new Map<SchemaName, ValidateFunction>();

/** Compiled validator for a schema (compiled once per process and cached). */
export function schemaValidator(name: SchemaName): ValidateFunction {
  let fn = compiled.get(name);
  if (!fn) {
    ajv ??= new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
    fn = ajv.compile(readSchema(name));
    compiled.set(name, fn);
  }
  return fn;
}

/** Structural (JSON Schema) validation; returns issues with JSON-pointer paths. */
export function schemaIssues(name: SchemaName, input: unknown): ValidationIssue[] {
  const fn = schemaValidator(name);
  if (fn(input)) return [];
  return (fn.errors ?? []).map(toIssue);
}

function toIssue(err: ErrorObject): ValidationIssue {
  let path = err.instancePath;
  let message = err.message ?? "is invalid";
  const params = err.params as Record<string, unknown>;
  if (err.keyword === "required" && typeof params.missingProperty === "string") {
    path = `${path}/${escapePointer(params.missingProperty)}`;
    message = "is required";
  } else if (err.keyword === "additionalProperties" && typeof params.additionalProperty === "string") {
    path = `${path}/${escapePointer(params.additionalProperty)}`;
    message = "is not allowed (unknown property)";
  } else if (err.keyword === "enum" && Array.isArray(params.allowedValues)) {
    message = `must be one of: ${params.allowedValues.map((v) => JSON.stringify(v)).join(", ")}`;
  } else if (err.keyword === "const") {
    message = `must equal ${JSON.stringify(params.allowedValue)}`;
  }
  return { path: path === "" ? "/" : path, message, severity: "error" };
}

export function escapePointer(segment: string | number): string {
  return String(segment).replace(/~/g, "~0").replace(/\//g, "~1");
}

export function pointer(...segments: Array<string | number>): string {
  return `/${segments.map(escapePointer).join("/")}`;
}

function assertSchemaName(name: string): asserts name is SchemaName {
  if (!(SCHEMA_NAMES as readonly string[]).includes(name)) {
    throw dsError("invalid_state", "context-analyzer", `Unknown schema "${name}"`);
  }
}
