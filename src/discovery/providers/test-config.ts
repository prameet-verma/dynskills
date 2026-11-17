import type { DiscoveryContext, DiscoveryEvidence, DiscoveryProvider } from "../../contracts/index.js";
import { loadPackageJsons, loadPyprojects } from "../manifests.js";
import { basename, depth, evidenceFactory, filesMatching, isRecord, readRepoFile, stringRecord } from "../util.js";

const CONFIG_FILES: Array<{ re: RegExp; tool: string }> = [
  { re: /(^|\/)vitest\.(config|workspace)\.(ts|mts|cts|js|mjs|cjs|json)$/, tool: "vitest" },
  { re: /(^|\/)jest\.config\.(ts|js|mjs|cjs|json)$/, tool: "jest" },
  { re: /(^|\/)playwright\.config\.(ts|js|mjs)$/, tool: "playwright" },
  { re: /(^|\/)cypress\.config\.(ts|js|mjs)$/, tool: "cypress" },
  { re: /(^|\/)karma\.conf\.(js|ts|cjs)$/, tool: "karma" },
  { re: /(^|\/)\.mocharc\.(js|cjs|json|ya?ml)$/, tool: "mocha" },
  { re: /(^|\/)pytest\.ini$/, tool: "pytest" },
  { re: /(^|\/)conftest\.py$/, tool: "pytest" },
  { re: /(^|\/)tox\.ini$/, tool: "tox" },
  { re: /(^|\/)noxfile\.py$/, tool: "nox" },
];

const TEST_FILE_GROUPS: Array<{ re: RegExp; label: string; runner: string }> = [
  { re: /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs|mts)$/, label: "JavaScript/TypeScript test files (*.test/*.spec)", runner: "js" },
  { re: /(^|\/)(test_[^/]+|[^/]+_test)\.py$/, label: "Python test modules (test_*.py)", runner: "pytest" },
  { re: /_test\.go$/, label: "Go test files (*_test.go)", runner: "go test" },
  { re: /(^|\/)src\/test\/(java|kotlin)\/.+\.(java|kt)$/, label: "JVM tests under src/test", runner: "jvm" },
  { re: /(^|\/)tests\/[^/]+\.rs$/, label: "Rust integration tests (tests/*.rs)", runner: "cargo test" },
];

/** P0: test framework configuration, test scripts and test file conventions. */
export class TestConfigProvider implements DiscoveryProvider {
  readonly id = "test-config";
  readonly priority = "P0" as const;

  supports(): boolean {
    return true;
  }

  async discover(ctx: DiscoveryContext): Promise<DiscoveryEvidence[]> {
    const ev = evidenceFactory(this.id, this.priority);
    const out: DiscoveryEvidence[] = [];

    for (const { re, tool } of CONFIG_FILES) {
      for (const p of filesMatching(ctx, re).filter((f) => depth(f) <= 3).slice(0, 10)) {
        out.push(ev("test_configuration", p, `${tool} configuration in ${basename(p)}`, { value: { tool } }));
      }
    }
    for (const { path, data } of await loadPackageJsons(ctx)) {
      const scripts = stringRecord(data.scripts);
      if (path === "package.json" && scripts["test"] === undefined) {
        // Without this, hosts guess `npm test`, which fails when the script doesn't exist.
        out.push(
          ev("test_configuration", path, 'package.json has no "test" script, so `npm test` fails; run the test runner directly', {
            value: { missingScript: "test" },
          }),
        );
      }
      for (const [name, cmd] of Object.entries(scripts)) {
        if (!/^(test|e2e)(:|$)|^test-/.test(name)) continue;
        out.push(ev("test_configuration", path, `Test script "${name}": ${cmd}`, { value: { script: name, command: cmd }, excerpt: `"${name}": "${cmd}"` }));
      }
      if (isRecord(data.jest)) out.push(ev("test_configuration", path, "jest configuration in package.json", { value: { tool: "jest" } }));
    }
    for (const { path, data } of await loadPyprojects(ctx)) {
      const tool = isRecord(data.tool) ? data.tool : {};
      const pytest = isRecord(tool.pytest) ? tool.pytest["ini_options"] : undefined;
      if (isRecord(pytest)) {
        out.push(ev("test_configuration", path, "pytest configured in [tool.pytest.ini_options]", { value: { tool: "pytest", options: pytest } }));
      }
    }
    for (const p of filesMatching(ctx, /(^|\/)setup\.cfg$/).filter((f) => depth(f) <= 2)) {
      const text = await readRepoFile(ctx, p, 64 * 1024);
      if (text && /^\[tool:pytest\]/m.test(text)) out.push(ev("test_configuration", p, "pytest configured in setup.cfg [tool:pytest]", { value: { tool: "pytest" } }));
    }
    out.push(...(await jsTestRunnerEvidence(ctx, ev)));
    for (const { re, label, runner } of TEST_FILE_GROUPS) {
      const files = filesMatching(ctx, re);
      if (!files.length) continue;
      out.push(
        ev("test_configuration", files[0] as string, `${files.length} ${label}`, {
          value: { runner, count: files.length, samples: files.slice(0, 5) },
          confidence: 0.9,
        }),
      );
    }
    return out;
  }
}

const JS_TEST_FILE = /\.(test|spec)\.(js|mjs|cjs|ts|mts|cts)$/;
const NODE_TEST_IMPORT = /(?:require\(\s*|from\s+|import\s+)["']node:test["']/;
/** A "how to run" comment at the top of a test file, e.g. `// Run: node --test test/a.test.js`. */
const RUN_HINT = /^\s*(?:\/\/|#|\*|\/\*)\s*Run(?:\s+with)?\s*:\s*`?([^`\n]+?)`?\s*(?:\*\/)?\s*$/im;

/**
 * Looks inside a few JavaScript/TypeScript test files for Node's built-in test runner and for a
 * documented run command. Config files and package.json scripts don't reveal either.
 */
async function jsTestRunnerEvidence(ctx: DiscoveryContext, ev: ReturnType<typeof evidenceFactory>): Promise<DiscoveryEvidence[]> {
  const out: DiscoveryEvidence[] = [];
  const files = filesMatching(ctx, JS_TEST_FILE).filter((f) => depth(f) <= 4).slice(0, 10);
  const nodeTestFiles: string[] = [];
  for (const p of files) {
    const head = await readRepoFile(ctx, p, 4 * 1024);
    if (!head) continue;
    const hint = RUN_HINT.exec(head)?.[1]?.trim();
    if (hint) out.push(ev("test_configuration", p, `Run command documented in ${basename(p)}: ${hint}`, { value: { command: hint }, excerpt: hint }));
    if (NODE_TEST_IMPORT.test(head)) nodeTestFiles.push(p);
  }
  if (nodeTestFiles.length > 0) {
    const first = nodeTestFiles[0] as string;
    out.push(
      ev("test_configuration", first, `Tests use Node's built-in test runner (node:test); run them with \`node --test\` (${nodeTestFiles.length} file(s), e.g. ${first})`, {
        value: { tool: "node:test", command: `node --test ${nodeTestFiles.join(" ")}`, files: nodeTestFiles },
      }),
    );
  }
  return out;
}
