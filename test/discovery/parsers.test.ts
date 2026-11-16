import { describe, expect, it } from "vitest";
import { parseDockerfileFrom, parseFrontmatter, parseGoMod, parseGradle, parseJsonc, parsePom, parseRequirementsTxt, parseToml } from "../../src/discovery/index.js";

describe("parsers", () => {
  it("parses the TOML subset used by pyproject and Cargo manifests", () => {
    const t = parseToml(`
# comment
[project]
name = "x" # trailing
description = """multi
line"""
dependencies = [
  "fastapi>=0.1",  # web
  'pydantic',
]
[tool.poetry.dependencies]
python = "^3.11"
sqlalchemy = { version = "^2.0", extras = ["asyncio"] }
[[bin]]
name = "a"
[[bin]]
name = "b"
`);
    expect(t).toMatchObject({
      project: { name: "x", description: "multi\nline", dependencies: ["fastapi>=0.1", "pydantic"] },
      tool: { poetry: { dependencies: { python: "^3.11", sqlalchemy: { version: "^2.0", extras: ["asyncio"] } } } },
      bin: [{ name: "a" }, { name: "b" }],
    });
    expect(() => parseToml("[unterminated\n")).toThrow();
  });

  it("parses go.mod, requirements, pom, gradle, Dockerfile, JSONC and frontmatter", () => {
    const go = parseGoMod("module m\n\ngo 1.22\ntoolchain go1.22.5\nrequire (\n\ta v1.0.0\n\tb v2.0.0 // indirect\n)\nrequire c v0.1.0\n");
    expect(go).toMatchObject({ module: "m", go: "1.22", toolchain: "go1.22.5" });
    expect(go.require.map((r) => [r.path, r.indirect])).toEqual([["a", false], ["b", true], ["c", false]]);

    expect(parseRequirementsTxt("# c\n-r base.txt\nDjango==5.0 ; python_version>'3'\nrequests[socks]>=2\n").map((r) => [r.name, r.spec])).toEqual([
      ["django", "==5.0"],
      ["requests", ">=2"],
    ]);

    const pom = parsePom(`<project><parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId><version>3.3.4</version></parent>
      <artifactId>svc</artifactId><properties><java.version>21</java.version><lib.v>1.2</lib.v></properties>
      <dependencies><dependency><groupId>g</groupId><artifactId>lib</artifactId><version>\${lib.v}</version><scope>test</scope></dependency></dependencies></project>`);
    expect(pom.artifactId).toBe("svc");
    expect(pom.parent?.version).toBe("3.3.4");
    expect(pom.properties["java.version"]).toBe("21");
    expect(pom.dependencies).toEqual([{ groupId: "g", artifactId: "lib", version: "1.2", scope: "test" }]);

    const gradle = parseGradle(`plugins { id 'org.springframework.boot' version '3.2.0'\n kotlin("jvm") version "1.9.0" }\ndependencies { implementation 'org.x:y:1.0'\n testImplementation("org.junit.jupiter:junit-jupiter:5.10.0") }\njava { toolchain { languageVersion = JavaLanguageVersion.of(17) } }`);
    expect(gradle.plugins).toEqual(expect.arrayContaining([{ id: "org.springframework.boot", version: "3.2.0" }, { id: "org.jetbrains.kotlin.jvm", version: "1.9.0" }]));
    expect(gradle.dependencies.map((d) => d.artifactId)).toEqual(["y", "junit-jupiter"]);
    expect(gradle.javaVersion).toBe("17");

    expect(parseDockerfileFrom("FROM --platform=linux/amd64 node:22-alpine AS build\nFROM registry:5000/python:3.12-slim\nFROM scratch\n").map((f) => [f.image, f.tag, f.stage])).toEqual([
      ["node", "22-alpine", "build"],
      ["registry:5000/python", "3.12-slim", undefined],
      ["scratch", undefined, undefined],
    ]);
    expect(parseJsonc('{ // c\n "a": "http://x", /* b */ "b": [1,2,], }')).toEqual({ a: "http://x", b: [1, 2] });
    expect(parseFrontmatter("---\nname: a\ndescription: b\n---\nbody")).toEqual({ name: "a", description: "b" });
    expect(parseFrontmatter("no frontmatter")).toBeUndefined();
    expect(parseFrontmatter("---\nname: [bad\n---\n")).toBeUndefined();
  });
});
