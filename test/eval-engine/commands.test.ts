import { describe, it, expect } from "vitest";
import { referencedScripts, unknownScriptFindings } from "../../src/eval-engine/commands.js";

describe("referencedScripts", () => {
  it("maps package-manager invocations to the scripts they run, ignoring built-ins", () => {
    const text = [
      "Run `npm test` and `npm run lint`.",
      "Then pnpm build, yarn test, and bun run e2e:smoke.",
      "Not scripts: pnpm install, npm ci, yarn add zod, bun test, npx vitest, node --test test/a.test.js.",
    ].join("\n");
    expect(referencedScripts(text).map((r) => r.script)).toEqual(["test", "lint", "build", "test", "e2e:smoke"]);
  });
});

describe("unknownScriptFindings", () => {
  const body = "## Verification\n\n- Run npm test and confirm tests pass.\n- Run `pnpm run lint`.\n";

  it("flags commands that run scripts package.json doesn't define", () => {
    const f = unknownScriptFindings(body, {});
    expect(f.map((x) => x.code)).toEqual(["unknown_script", "unknown_script"]);
    expect(f[0]?.severity).toBe("error");
    expect(f[0]?.message).toMatch(/`npm test` runs the "test" script, but package.json has no such script/);
  });

  it("accepts scripts that exist, and skips the check without a package.json", () => {
    expect(unknownScriptFindings(body, { test: "vitest run", lint: "eslint ." })).toEqual([]);
    expect(unknownScriptFindings(body, undefined)).toEqual([]);
  });
});
