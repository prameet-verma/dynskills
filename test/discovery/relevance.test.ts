import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { scorePath, taskKeywords, taskMentionedPaths } from "../../src/discovery/relevance.js";
import { Orchestrator } from "../../src/orchestrator/index.js";
import type { ContextPacket } from "../../src/contracts/index.js";

const FILES = ["lib/script-engine.js", "lib/utils.js", "content/inject.js", "content/content.js", "sandbox/sandbox.js", "a/util.js", "b/util.js"];

describe("files named in the task", () => {
  it("resolves exact paths, unique suffixes and unique file names; ignores ambiguous and unknown ones", () => {
    const task = { description: "Wire lib/script-engine.js into ./content/inject.js; see sandbox.js, util.js, window.postMessage and e.g. missing/file.js." };
    expect(taskMentionedPaths(task, FILES).sort()).toEqual(["content/inject.js", "lib/script-engine.js", "sandbox/sandbox.js"]);
  });

  it("keeps folder names in named paths out of the keywords", () => {
    const kw = taskKeywords({ description: "Wire lib/script-engine.js into the sandbox bridge" });
    expect(kw).not.toContain("lib");
    expect(kw).toEqual(expect.arrayContaining(["sandbox", "bridg"].map((k) => expect.stringMatching(new RegExp(`^${k}`)))));
  });

  it("weights a named file above any keyword match, and a folder-only match below a file-name match", () => {
    const named = scorePath("content/inject.js", ["sandbox"], [], new Set(["content/inject.js"]));
    const fileMatch = scorePath("lib/sandbox.js", ["sandbox"]);
    const dirOnly = scorePath("sandbox/utils.js", ["sandbox"]);
    expect(named.score).toBeGreaterThan(fileMatch.score);
    expect(fileMatch.score).toBeGreaterThan(dirOnly.score);
    expect(dirOnly.score).toBeLessThanOrEqual(1);
  });
});

describe("context packet source files", () => {
  it("puts named files first, adds the tests that exercise them, and leaves out folder neighbours", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ds-relevance-"));
    const home = await mkdtemp(path.join(tmpdir(), "ds-relevance-home-"));
    const big = Array.from({ length: 400 }, (_, i) => `export function handler${i}(req) { return req.headers.get("x-${i}"); }`).join("\n");
    const files: Record<string, string> = {
      "package.json": JSON.stringify({ name: "ext", version: "1.0.0" }),
      "lib/script-engine.js": "export function applyRequestScripts(data) { return data; }\n",
      "lib/graphql-detector.js": "export const isGraphQL = () => false;\n",
      "lib/storage-manager.js": "export const load = () => ({});\n",
      "content/inject.js": `${big}\n`,
      "test/breakpoints.test.js": "// Run: node --test test/breakpoints.test.js\nconst SRC = require('fs').readFileSync('../content/inject.js', 'utf8');\n",
    };
    for (const [rel, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
      await writeFile(path.join(root, rel), content);
    }
    const orch = new Orchestrator({ root, harness: "claude", homeDir: home, sessionId: "sess_rel", env: { PATH: "" } });
    const s = await orch.start({ task: { description: "Wire lib/script-engine.js into content/inject.js" }, forceGenerate: true });
    const packet = JSON.parse(await readFile(s.packetPath as string, "utf8")) as ContextPacket;
    const paths = packet.sourceFiles.map((f) => f.path);
    expect(paths.slice(0, 2).sort()).toEqual(["content/inject.js", "lib/script-engine.js"]);
    expect(paths[2]).toBe("test/breakpoints.test.js");
    expect(packet.sourceFiles[2]?.reason).toMatch(/tests content\/inject\.js/);
    expect(paths).not.toContain("lib/graphql-detector.js");
    expect(paths).not.toContain("lib/storage-manager.js");
  });
});
