import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  redactSecrets, readTextFileBounded, resolveInsideRoot, isExcludedPath, isSensitivePath,
  hashSkillFiles, evidenceId, estimateTokens, truncateToTokens, writeDirAtomic,
  mapWithConcurrency, withTimeout, TimeoutError, monotonicNowMs, clockEpoch, sameClockEpoch, DynamicSkillsError,
} from "../../src/core/index.js";

async function tmp(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "ds-core-"));
}

describe("fs-safety", () => {
  it("rejects traversal outside root", () => {
    expect(() => resolveInsideRoot("/repo", "../etc/passwd")).toThrow(DynamicSkillsError);
    expect(resolveInsideRoot("/repo", "src/a.ts")).toBe(path.resolve("/repo/src/a.ts"));
  });
  it("classifies sensitive and excluded paths", () => {
    for (const p of [".env", "config/.env.local", "certs/server.pem", "id.key", "a.p12", "b.pfx", "credentials.json", "secrets.yaml"]) {
      expect(isSensitivePath(p), p).toBe(true);
    }
    expect(isExcludedPath("node_modules/x/index.js")).toBe(true);
    expect(isExcludedPath("packages/a/dist/x.js")).toBe(true);
    expect(isExcludedPath("src/env.ts")).toBe(false);
  });
  it("reads bounded text and skips sensitive, binary and escaping symlinks", async () => {
    const root = await tmp();
    const outside = await tmp();
    await writeFile(path.join(root, "a.txt"), "x".repeat(100));
    await writeFile(path.join(root, ".env"), "SECRET=1");
    await writeFile(path.join(root, "bin.dat"), Buffer.from([1, 0, 2]));
    await writeFile(path.join(outside, "s.txt"), "outside");
    await symlink(path.join(outside, "s.txt"), path.join(root, "link.txt"));
    const r = await readTextFileBounded(root, "a.txt", 10);
    expect(r).toMatchObject({ content: "x".repeat(10), truncated: true, bytes: 10 });
    expect(await readTextFileBounded(root, ".env", 100)).toMatchObject({ skipped: "sensitive" });
    expect(await readTextFileBounded(root, "bin.dat", 100)).toMatchObject({ skipped: "binary" });
    expect(await readTextFileBounded(root, "link.txt", 100)).toMatchObject({ skipped: "outside_root" });
    expect(await readTextFileBounded(root, "missing.txt", 100)).toMatchObject({ skipped: "not_found" });
    expect(await readTextFileBounded(root, "../x", 100)).toMatchObject({ skipped: "outside_root" });
  });
});

describe("redactSecrets", () => {
  it("redacts common secret shapes", () => {
    const input = [
      `AWS=${"AKIA"}ABCDEFGHIJKLMNOP`,
      `token: ${"ghp"}_abcdefghijklmnopqrstuvwxyz0123456789AB`,
      'apiKey = "supersecretvalue123"',
      "DATABASE_URL=postgres://user:hunter2@db:5432/x",
      "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const { text, redactions } = redactSecrets(input);
    expect(redactions).toBeGreaterThanOrEqual(5);
    for (const s of [`${"AKIA"}ABCDEFGHIJKLMNOP`, `${"ghp"}_abc`, "supersecretvalue123", "hunter2", "abc\n-----END"]) expect(text).not.toContain(s);
  });
  it("leaves ordinary code alone", () => {
    const src = "const tokenizer = new Tokenizer();\nfunction getPassword() { return prompt(); }";
    expect(redactSecrets(src)).toEqual({ text: src, redactions: 0 });
  });
});

describe("hashing and tokens", () => {
  it("hashSkillFiles is order-independent and content-sensitive", () => {
    const a = [{ path: "SKILL.md", content: "a" }, { path: "references/x.md", content: "b" }];
    expect(hashSkillFiles(a)).toBe(hashSkillFiles([...a].reverse()));
    expect(hashSkillFiles(a)).not.toBe(hashSkillFiles([{ path: "SKILL.md", content: "a!" }, a[1]!]));
  });
  it("evidenceId is deterministic", () => {
    expect(evidenceId("p", "k", "s", "c")).toMatch(/^ev_[0-9a-f]{12}$/);
    expect(evidenceId("p", "k", "s", "c")).toBe(evidenceId("p", "k", "s", "c"));
  });
  it("estimates and truncates tokens", () => {
    expect(estimateTokens("abcd".repeat(100))).toBe(100);
    const t = truncateToTokens("line\n".repeat(1000), 50);
    expect(t.truncated).toBe(true);
    expect(estimateTokens(t.text)).toBeLessThanOrEqual(50);
  });
});

describe("atomic writes", () => {
  it("writes a directory and refuses overwrite without approval", async () => {
    const root = await tmp();
    const dest = path.join(root, "skills", "my-skill");
    await writeDirAtomic(dest, [{ path: "SKILL.md", content: "one" }, { path: "references/r.md", content: "r" }]);
    expect(await readFile(path.join(dest, "SKILL.md"), "utf8")).toBe("one");
    await expect(writeDirAtomic(dest, [{ path: "SKILL.md", content: "two" }])).rejects.toThrow(/Refusing to overwrite/);
    await writeDirAtomic(dest, [{ path: "SKILL.md", content: "two" }], { overwrite: true });
    expect(await readFile(path.join(dest, "SKILL.md"), "utf8")).toBe("two");
    expect((await readdir(path.join(root, "skills"))).filter((n) => n.startsWith("."))).toEqual([]);
  });
  it("rejects file paths that escape the skill directory", async () => {
    const root = await tmp();
    await expect(writeDirAtomic(path.join(root, "s"), [{ path: "../evil.md", content: "x" }])).rejects.toThrow(/escapes/);
  });
});

describe("concurrency and clock", () => {
  it("bounds concurrency and preserves order", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (n) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12]);
    expect(peak).toBe(2);
  });
  it("times out and aborts the signal", async () => {
    let aborted = false;
    await expect(
      withTimeout((signal) => new Promise((r) => { signal.addEventListener("abort", () => { aborted = true; }); setTimeout(r, 200); }), 20),
    ).rejects.toBeInstanceOf(TimeoutError);
    expect(aborted).toBe(true);
  });
  it("monotonic clock advances and epoch is stable", async () => {
    const a = monotonicNowMs();
    await new Promise((r) => setTimeout(r, 10));
    expect(monotonicNowMs() - a).toBeGreaterThanOrEqual(9);
    expect(sameClockEpoch(clockEpoch(), clockEpoch())).toBe(true);
  });
});
