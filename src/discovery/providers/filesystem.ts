import type { DiscoveryContext, DiscoveryEvidence, DiscoveryProvider } from "../../contracts/index.js";
import { basename, evidenceFactory } from "../util.js";

const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript",
  mts: "TypeScript",
  cts: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  py: "Python",
  go: "Go",
  java: "Java",
  kt: "Kotlin",
  kts: "Kotlin",
  scala: "Scala",
  rs: "Rust",
  rb: "Ruby",
  php: "PHP",
  cs: "C#",
  swift: "Swift",
  c: "C",
  h: "C",
  cpp: "C++",
  cc: "C++",
  hpp: "C++",
  ex: "Elixir",
  exs: "Elixir",
  dart: "Dart",
  vue: "Vue",
  svelte: "Svelte",
};

const ENTRYPOINT_PATTERNS: RegExp[] = [
  /^(src\/)?(index|main|server|app|cli)\.(ts|tsx|js|mjs|cjs)$/,
  /^(apps|packages|services)\/[^/]+\/(src\/)?(index|main|server|app)\.(ts|tsx|js|mjs)$/,
  /^(src\/)?(main|app|__main__|manage|wsgi|asgi)\.py$/,
  /^[^/]+\/(main|app|__main__)\.py$/,
  /(^|\/)cmd\/[^/]+\/main\.go$/,
  /^([^/]+\/)?main\.go$/,
  /(^|\/)src\/main\/java\/.+Application\.(java|kt)$/,
  /(^|\/)src\/main\.rs$/,
  /(^|\/)src\/bin\/[^/]+\.rs$/,
];

/** P0: top-level structure, language mix by extension, conventional entry points. */
export class FileSystemProvider implements DiscoveryProvider {
  readonly id = "filesystem";
  readonly priority = "P0" as const;

  supports(): boolean {
    return true;
  }

  async discover(ctx: DiscoveryContext): Promise<DiscoveryEvidence[]> {
    const ev = evidenceFactory(this.id, this.priority);
    const out: DiscoveryEvidence[] = [];

    const dirCounts = new Map<string, number>();
    const langCounts = new Map<string, number>();
    for (const p of ctx.fileIndex) {
      const slash = p.indexOf("/");
      if (slash > 0) {
        const top = p.slice(0, slash);
        dirCounts.set(top, (dirCounts.get(top) ?? 0) + 1);
      }
      const name = basename(p);
      const dot = name.lastIndexOf(".");
      if (dot > 0) {
        const lang = LANGUAGE_BY_EXT[name.slice(dot + 1).toLowerCase()];
        if (lang) langCounts.set(lang, (langCounts.get(lang) ?? 0) + 1);
      }
    }

    for (const [dir, count] of [...dirCounts].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
      out.push(ev("directory", dir, `Top-level directory ${dir}/ contains ${count} files`, { value: { path: dir, files: count } }));
    }
    for (const [lang, count] of langCounts) {
      out.push(
        ev("language", ".", `Repository contains ${count} ${lang} source file${count === 1 ? "" : "s"}`, {
          value: { language: lang, files: count },
          confidence: 0.8,
        }),
      );
    }
    for (const p of ctx.fileIndex.filter((f) => ENTRYPOINT_PATTERNS.some((re) => re.test(f))).slice(0, 25)) {
      out.push(ev("entrypoint", p, `Conventional entry point ${p}`, { value: { path: p }, confidence: 0.7 }));
    }
    return out;
  }
}
