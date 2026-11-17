import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error -- plain .mjs script without type declarations
import { VERSION_SITES } from "../../scripts/sync-version.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { version } = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version: string };

describe("version sync", () => {
  it.each(VERSION_SITES as Array<[string, RegExp]>)("%s carries the package.json version", (rel) => {
    const text = readFileSync(path.join(ROOT, rel), "utf8");
    expect(text, `${rel} is out of sync: run \`node scripts/sync-version.mjs\``).toContain(version);
  });
});
