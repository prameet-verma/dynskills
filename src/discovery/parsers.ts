/**
 * Small, dependency-free parsers for manifest formats that have no parser in our dependency set.
 * They are deliberately partial: enough structure for deterministic discovery, never `eval`.
 */
import { parse as parseYaml } from "yaml";
import { isRecord } from "./util.js";

// ---------------------------------------------------------------------------
// JSON with comments (tsconfig, devcontainer, etc.)
// ---------------------------------------------------------------------------

/** Remove // and /* *\/ comments and trailing commas outside strings. */
export function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    const n = text[i + 1];
    if (inString) {
      out += c;
      if (c === "\\") {
        out += n ?? "";
        i++;
      } else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && n === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && n === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

export function parseJsonc(text: string): unknown {
  return JSON.parse(stripJsonComments(text));
}

// ---------------------------------------------------------------------------
// TOML subset (pyproject.toml, Cargo.toml)
// ---------------------------------------------------------------------------

export type TomlTable = Record<string, unknown>;

/**
 * Parses tables, array-of-tables, dotted/quoted keys, strings (basic, literal, multi-line), numbers,
 * booleans, arrays (multi-line) and inline tables. Dates and other scalars are kept as raw strings.
 * Throws on malformed input.
 */
export function parseToml(text: string): TomlTable {
  const root: TomlTable = {};
  let current: TomlTable = root;
  let i = 0;
  const len = text.length;

  const fail = (msg: string): never => {
    throw new Error(`TOML parse error at offset ${i}: ${msg}`);
  };
  const skipWs = () => {
    while (i < len && (text[i] === " " || text[i] === "\t")) i++;
  };
  const skipWsNlComments = () => {
    for (;;) {
      while (i < len && /\s/.test(text[i] as string)) i++;
      if (text[i] === "#") {
        while (i < len && text[i] !== "\n") i++;
      } else return;
    }
  };
  const parseBasicString = (): string => {
    i++; // opening "
    let s = "";
    while (i < len && text[i] !== '"') {
      if (text[i] === "\n") fail("newline in string");
      if (text[i] === "\\") {
        const e = text[i + 1];
        s += e === "n" ? "\n" : e === "t" ? "\t" : e === '"' ? '"' : e === "\\" ? "\\" : (e ?? "");
        i += 2;
      } else s += text[i++];
    }
    if (i >= len) fail("unterminated string");
    i++;
    return s;
  };
  const parseLiteralString = (): string => {
    const end = text.indexOf("'", i + 1);
    if (end < 0) fail("unterminated literal string");
    const s = text.slice(i + 1, end);
    i = end + 1;
    return s;
  };
  const parseMultiline = (delim: string): string => {
    const end = text.indexOf(delim, i + 3);
    if (end < 0) fail("unterminated multi-line string");
    const s = text.slice(i + 3, end).replace(/^\r?\n/, "");
    i = end + 3;
    return s;
  };
  const parseKey = (): string[] => {
    const parts: string[] = [];
    for (;;) {
      skipWs();
      const c = text[i];
      if (c === '"') parts.push(parseBasicString());
      else if (c === "'") parts.push(parseLiteralString());
      else {
        const m = /^[A-Za-z0-9_-]+/.exec(text.slice(i, i + 256));
        if (!m) fail("expected key");
        parts.push((m as RegExpExecArray)[0]);
        i += (m as RegExpExecArray)[0].length;
      }
      skipWs();
      if (text[i] === ".") i++;
      else return parts;
    }
  };
  const parseValue = (): unknown => {
    const c = text[i];
    if (text.startsWith('"""', i)) return parseMultiline('"""');
    if (text.startsWith("'''", i)) return parseMultiline("'''");
    if (c === '"') return parseBasicString();
    if (c === "'") return parseLiteralString();
    if (c === "[") {
      i++;
      const arr: unknown[] = [];
      for (;;) {
        skipWsNlComments();
        if (text[i] === "]") {
          i++;
          return arr;
        }
        arr.push(parseValue());
        skipWsNlComments();
        if (text[i] === ",") i++;
        else if (text[i] !== "]") fail("expected , or ] in array");
      }
    }
    if (c === "{") {
      i++;
      const obj: TomlTable = {};
      for (;;) {
        skipWs();
        if (text[i] === "}") {
          i++;
          return obj;
        }
        const key = parseKey();
        if (text[i] !== "=") fail("expected = in inline table");
        i++;
        skipWs();
        setPath(obj, key, parseValue());
        skipWs();
        if (text[i] === ",") i++;
        else if (text[i] !== "}") fail("expected , or } in inline table");
      }
    }
    const m = /^[^,\]}\s#]+/.exec(text.slice(i, i + 128));
    if (!m) fail("expected value");
    const raw = (m as RegExpExecArray)[0];
    i += raw.length;
    if (raw === "true") return true;
    if (raw === "false") return false;
    if (/^[+-]?\d[\d_]*(\.\d+)?$/.test(raw)) return Number(raw.replace(/_/g, ""));
    return raw;
  };
  const setPath = (obj: TomlTable, keys: string[], value: unknown) => {
    let t = obj;
    for (const k of keys.slice(0, -1)) {
      if (!isRecord(t[k])) t[k] = {};
      t = t[k] as TomlTable;
    }
    t[keys[keys.length - 1] as string] = value;
  };
  const tableAt = (keys: string[], arrayOfTables: boolean): TomlTable => {
    let t = root;
    keys.forEach((k, idx) => {
      const last = idx === keys.length - 1;
      if (last && arrayOfTables) {
        if (!Array.isArray(t[k])) t[k] = [];
        const next: TomlTable = {};
        (t[k] as unknown[]).push(next);
        t = next;
        return;
      }
      const existing = t[k];
      if (Array.isArray(existing)) {
        const lastEntry = existing[existing.length - 1];
        t = isRecord(lastEntry) ? lastEntry : {};
      } else {
        if (!isRecord(existing)) t[k] = {};
        t = t[k] as TomlTable;
      }
    });
    return t;
  };

  for (;;) {
    skipWsNlComments();
    if (i >= len) break;
    if (text[i] === "[") {
      const aot = text[i + 1] === "[";
      i += aot ? 2 : 1;
      const keys = parseKey();
      if (aot ? !text.startsWith("]]", i) : text[i] !== "]") fail("unterminated table header");
      i += aot ? 2 : 1;
      current = tableAt(keys, aot);
    } else {
      const keys = parseKey();
      if (text[i] !== "=") fail("expected =");
      i++;
      skipWs();
      setPath(current, keys, parseValue());
    }
    skipWs();
    if (text[i] === "#") while (i < len && text[i] !== "\n") i++;
    if (i < len && text[i] !== "\n" && text[i] !== "\r") fail("expected end of line");
  }
  return root;
}

// ---------------------------------------------------------------------------
// go.mod
// ---------------------------------------------------------------------------

export interface GoMod {
  module?: string;
  go?: string;
  toolchain?: string;
  require: Array<{ path: string; version: string; indirect: boolean; line: number }>;
}

export function parseGoMod(text: string): GoMod {
  const out: GoMod = { require: [] };
  let inRequire = false;
  text.split(/\r?\n/).forEach((raw, idx) => {
    const indirect = /\/\/\s*indirect/.test(raw);
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (!line) return;
    if (inRequire) {
      if (line === ")") inRequire = false;
      else {
        const [p, v] = line.split(/\s+/);
        if (p && v) out.require.push({ path: p, version: v, indirect, line: idx + 1 });
      }
      return;
    }
    const [kw, ...rest] = line.split(/\s+/);
    if (kw === "module") out.module = rest[0]?.replace(/"/g, "");
    else if (kw === "go" && rest[0]) out.go = rest[0];
    else if (kw === "toolchain" && rest[0]) out.toolchain = rest[0];
    else if (kw === "require") {
      if (rest[0] === "(") inRequire = true;
      else if (rest[0] && rest[1]) out.require.push({ path: rest[0], version: rest[1], indirect, line: idx + 1 });
    }
  });
  return out;
}

/** go.work `use` directives. */
export function parseGoWork(text: string): string[] {
  const out: string[] = [];
  let inUse = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (!line) continue;
    if (inUse) {
      if (line === ")") inUse = false;
      else out.push(line);
    } else if (line.startsWith("use")) {
      const rest = line.slice(3).trim();
      if (rest === "(") inUse = true;
      else if (rest) out.push(rest);
    }
  }
  return out.map((p) => p.replace(/^\.\//, "").replace(/"/g, ""));
}

// ---------------------------------------------------------------------------
// requirements.txt
// ---------------------------------------------------------------------------

export interface PythonRequirement {
  name: string;
  spec?: string;
  line: number;
}

/** PEP 508-ish requirement string: "fastapi[all]>=0.115,<1 ; python_version>'3.8'". */
export function parsePep508(req: string): { name: string; spec?: string } | undefined {
  const s = req.split(";")[0]?.trim() ?? "";
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*(.*)$/.exec(s);
  if (!m?.[1]) return undefined;
  const spec = (m[3] ?? "").trim().replace(/^\(|\)$/g, "");
  return { name: m[1].toLowerCase(), ...(spec ? { spec } : {}) };
}

export function parseRequirementsTxt(text: string): PythonRequirement[] {
  const out: PythonRequirement[] = [];
  text.split(/\r?\n/).forEach((raw, idx) => {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (!line || line.startsWith("-") || /^(git|https?|file):/.test(line)) return;
    const r = parsePep508(line);
    if (r) out.push({ ...r, line: idx + 1 });
  });
  return out;
}

// ---------------------------------------------------------------------------
// pom.xml (basic)
// ---------------------------------------------------------------------------

export interface MavenDependency {
  groupId: string;
  artifactId: string;
  version?: string;
  scope?: string;
}

export interface PomInfo {
  groupId?: string;
  artifactId?: string;
  version?: string;
  packaging?: string;
  parent?: MavenDependency;
  properties: Record<string, string>;
  modules: string[];
  dependencies: MavenDependency[];
  plugins: MavenDependency[];
}

function tag(xml: string, name: string): string | undefined {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml);
  return m?.[1]?.trim();
}

function blocks(xml: string, name: string): string[] {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "g");
  return [...xml.matchAll(re)].map((m) => m[1] ?? "");
}

function coordinates(xml: string): MavenDependency | undefined {
  const groupId = tag(xml, "groupId");
  const artifactId = tag(xml, "artifactId");
  if (!artifactId) return undefined;
  const version = tag(xml, "version");
  const scope = tag(xml, "scope");
  return { groupId: groupId ?? "", artifactId, ...(version ? { version } : {}), ...(scope ? { scope } : {}) };
}

export function parsePom(text: string): PomInfo {
  const xml = text.replace(/<!--[\s\S]*?-->/g, "");
  const parentXml = tag(xml, "parent");
  // Remove nested sections so project-level coordinates are not confused with them.
  const top = xml
    .replace(/<parent>[\s\S]*?<\/parent>/g, "")
    .replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g, "")
    .replace(/<dependencies>[\s\S]*?<\/dependencies>/g, "")
    .replace(/<build>[\s\S]*?<\/build>/g, "")
    .replace(/<profiles>[\s\S]*?<\/profiles>/g, "")
    .replace(/<properties>[\s\S]*?<\/properties>/g, "")
    .replace(/<modules>[\s\S]*?<\/modules>/g, "");
  const properties: Record<string, string> = {};
  const propsXml = tag(xml, "properties");
  if (propsXml) {
    for (const m of propsXml.matchAll(/<([A-Za-z0-9_.-]+)>([^<]*)<\/\1>/g)) {
      if (m[1] && m[2] !== undefined) properties[m[1]] = m[2].trim();
    }
  }
  const resolve = (v: string | undefined): string | undefined =>
    v?.replace(/\$\{([^}]+)\}/g, (whole, key: string) => properties[key] ?? whole);
  const depsSection = xml.replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g, "").replace(/<build>[\s\S]*?<\/build>/g, "");
  const dependencies = blocks(tag(depsSection, "dependencies") ?? "", "dependency")
    .map(coordinates)
    .filter((d): d is MavenDependency => !!d)
    .map((d) => ({ ...d, ...(d.version ? { version: resolve(d.version) as string } : {}) }));
  const plugins = blocks(tag(xml, "build") ?? "", "plugin")
    .map(coordinates)
    .filter((d): d is MavenDependency => !!d);
  const parent = parentXml ? coordinates(parentXml) : undefined;
  const info: PomInfo = {
    properties,
    modules: blocks(tag(xml, "modules") ?? "", "module").map((m) => m.trim()),
    dependencies,
    plugins,
  };
  const g = tag(top, "groupId");
  const a = tag(top, "artifactId");
  const v = tag(top, "version");
  const p = tag(top, "packaging");
  if (g) info.groupId = g;
  if (a) info.artifactId = a;
  if (v) info.version = resolve(v) as string;
  if (p) info.packaging = p;
  if (parent) info.parent = parent;
  return info;
}

// ---------------------------------------------------------------------------
// build.gradle / build.gradle.kts (basic)
// ---------------------------------------------------------------------------

export interface GradleInfo {
  plugins: Array<{ id: string; version?: string }>;
  dependencies: Array<{ configuration: string; groupId: string; artifactId: string; version?: string }>;
  javaVersion?: string;
}

export function parseGradle(text: string): GradleInfo {
  const src = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const plugins: GradleInfo["plugins"] = [];
  for (const m of src.matchAll(/\bid\s*\(?\s*["']([^"']+)["']\s*\)?(?:\s*version\s*\(?\s*["']([^"']+)["'])?/g)) {
    if (m[1]) plugins.push({ id: m[1], ...(m[2] ? { version: m[2] } : {}) });
  }
  for (const m of src.matchAll(/\bkotlin\s*\(\s*["']([^"']+)["']\s*\)(?:\s+version\s+["']([^"']+)["'])?/g)) {
    if (m[1]) plugins.push({ id: `org.jetbrains.kotlin.${m[1]}`, ...(m[2] ? { version: m[2] } : {}) });
  }
  for (const m of src.matchAll(/^\s*apply\s+plugin\s*:\s*["']([^"']+)["']/gm)) if (m[1]) plugins.push({ id: m[1] });
  const dependencies: GradleInfo["dependencies"] = [];
  const depRe =
    /\b(implementation|api|compileOnly|runtimeOnly|testImplementation|testRuntimeOnly|annotationProcessor|kapt|developmentOnly)\s*\(?\s*["']([^"':]+):([^"':]+)(?::([^"']+))?["']/g;
  for (const m of src.matchAll(depRe)) {
    if (m[1] && m[2] && m[3]) dependencies.push({ configuration: m[1], groupId: m[2], artifactId: m[3], ...(m[4] ? { version: m[4] } : {}) });
  }
  const info: GradleInfo = { plugins, dependencies };
  const java =
    /languageVersion\s*(?:\.set\s*\(|=)\s*JavaLanguageVersion\.of\s*\(\s*(\d+)\s*\)/.exec(src)?.[1] ??
    /sourceCompatibility\s*=\s*(?:JavaVersion\.VERSION_)?["']?([\d._]+)["']?/.exec(src)?.[1]?.replace(/^1_|_/g, (s) => (s === "_" ? "." : ""));
  if (java) info.javaVersion = java;
  return info;
}

/** settings.gradle `include` directives → project paths ("a:b" → "a/b"). */
export function parseGradleSettings(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/^\s*include\s*\(?([^\n)]*)\)?/gm)) {
    for (const s of (m[1] ?? "").matchAll(/["']([^"']+)["']/g)) {
      if (s[1]) out.push(s[1].replace(/^:/, "").replace(/:/g, "/"));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Runtime version files, Dockerfile, Makefile, .tool-versions
// ---------------------------------------------------------------------------

/** .nvmrc / .node-version / .python-version: first meaningful line. */
export function parseVersionFile(text: string): string | undefined {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (line) return line.replace(/^v(?=\d)/, "");
  }
  return undefined;
}

export function parseToolVersions(text: string): Array<{ tool: string; version: string; line: number }> {
  const out: Array<{ tool: string; version: string; line: number }> = [];
  text.split(/\r?\n/).forEach((raw, idx) => {
    const line = raw.replace(/#.*$/, "").trim();
    const [tool, version] = line.split(/\s+/);
    if (tool && version) out.push({ tool, version, line: idx + 1 });
  });
  return out;
}

export interface DockerFrom {
  image: string;
  tag?: string;
  stage?: string;
  line: number;
}

export function parseDockerfileFrom(text: string): DockerFrom[] {
  const out: DockerFrom[] = [];
  text.split(/\r?\n/).forEach((raw, idx) => {
    const m = /^\s*FROM\s+(?:--\S+\s+)*([^\s@]+)(?:@\S+)?(?:\s+AS\s+(\S+))?/i.exec(raw);
    if (!m?.[1]) return;
    const ref = m[1];
    // Split "registry:5000/name:tag" correctly: the tag colon is after the last slash.
    const slash = ref.lastIndexOf("/");
    const colon = ref.indexOf(":", slash + 1);
    const image = colon >= 0 ? ref.slice(0, colon) : ref;
    const tagPart = colon >= 0 ? ref.slice(colon + 1) : undefined;
    out.push({ image, ...(tagPart ? { tag: tagPart } : {}), ...(m[2] ? { stage: m[2] } : {}), line: idx + 1 });
  });
  return out;
}

/** Map a container base image to a runtime + version, e.g. node:22-alpine → node 22. */
export function runtimeFromImage(from: DockerFrom): { runtime: string; version?: string } | undefined {
  const name = from.image.split("/").pop()?.toLowerCase() ?? "";
  const t = from.tag ?? "";
  const leading = /^v?(\d+(?:\.\d+)*)/.exec(t)?.[1];
  const table: Record<string, string> = {
    node: "node",
    python: "python",
    golang: "go",
    rust: "rust",
    openjdk: "java",
    "eclipse-temurin": "java",
    amazoncorretto: "java",
    "ibm-semeru-runtimes": "java",
    "sapmachine": "java",
    bun: "bun",
    deno: "deno",
    ruby: "ruby",
  };
  if (name === "maven" || name === "gradle") {
    const jdk = /(?:temurin|jdk|corretto|openjdk)-?(\d+)/.exec(t)?.[1];
    return { runtime: "java", ...(jdk ? { version: jdk } : {}) };
  }
  const runtime = table[name];
  if (!runtime) return undefined;
  return { runtime, ...(leading ? { version: leading } : {}) };
}

export function parseMakefileTargets(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/^([A-Za-z0-9][A-Za-z0-9_.-]*)\s*:(?!=)/gm)) if (m[1] && !m[1].startsWith(".")) out.add(m[1]);
  return [...out];
}

// ---------------------------------------------------------------------------
// SKILL.md frontmatter
// ---------------------------------------------------------------------------

/** Parse YAML frontmatter; returns undefined when absent or malformed (never throws). */
export function parseFrontmatter(text: string): Record<string, unknown> | undefined {
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(text);
  if (!m) return undefined;
  try {
    const data: unknown = parseYaml(m[1] ?? "");
    return isRecord(data) ? data : undefined;
  } catch {
    return undefined;
  }
}

export function safeYaml(text: string): unknown {
  try {
    return parseYaml(text);
  } catch {
    return undefined;
  }
}
