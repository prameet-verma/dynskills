#!/usr/bin/env node
// Copies the version from package.json into every file that embeds it.
// Runs automatically from the npm `version` lifecycle script (`npm version patch|minor|major`),
// and test/core/version-sync.test.ts fails if any copy drifts.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

/** [file, pattern whose first group is the text before the version] */
export const VERSION_SITES = [
  ["src/core/version.ts", /(export const GENERATOR_VERSION = ")[^"]+(")/],
  ["plugins/claude-code/dynskills/.claude-plugin/plugin.json", /("version": ")[^"]+(")/],
  ["plugins/codex/dynskills/plugin.json", /("version": ")[^"]+(")/],
  ["skills/dynamic-skill-bootstrap/SKILL.md", /(dynamic-skills\.generator-version: )\S+()/],
  ["plugins/claude-code/dynskills/skills/dynamic-skill-bootstrap/SKILL.md", /(dynamic-skills\.generator-version: )\S+()/],
  ["plugins/codex/dynskills/skills/dynamic-skill-bootstrap/SKILL.md", /(dynamic-skills\.generator-version: )\S+()/],
];

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const [rel, re] of VERSION_SITES) {
    const file = path.join(root, rel);
    const before = readFileSync(file, "utf8");
    if (!re.test(before)) throw new Error(`sync-version: no version found in ${rel}`);
    const after = before.replace(re, `$1${version}$2`);
    if (after !== before) writeFileSync(file, after);
    console.log(`${rel}: ${version}`);
  }
}
