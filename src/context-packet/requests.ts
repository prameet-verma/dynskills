import path from "node:path";
import type { ContextPacket, ContextRequest, DiscoveryEvidence, DiscoveryLimits, EvidenceKind } from "../contracts/index.js";
import { evidenceId, isExcludedPath, isSensitivePath, redactSecrets, toPosix } from "../core/index.js";
import { buildFileIndex } from "../discovery/file-index.js";
import { isDocumentationPath } from "../discovery/providers/documentation.js";
import { extractKeywords, isSourcePath, rankPaths } from "../discovery/relevance.js";
import { compareEvidence } from "../discovery/util.js";
import {
  ENTRY_OVERHEAD_TOKENS,
  LimitTracker,
  MIN_USEFUL_TOKENS,
  byteLength,
  contentBytes,
  contentFileCount,
  enforceTokenBudget,
  finalizeTokens,
  fitContent,
  measurePacket,
  readRedacted,
  resolveLimits,
} from "./budget.js";

export interface ApplyContextRequestsInput {
  packet: ContextPacket;
  requests: ContextRequest[];
  root: string;
  limits: DiscoveryLimits;
  /** File index from the original scan; built lazily (names only, once) when a query needs it. */
  fileIndex?: string[];
}

export interface ApplyContextRequestsResult {
  packet: ContextPacket;
  fulfilled: ContextRequest[];
  rejected: Array<{ request: ContextRequest; reason: string }>;
}

const REQUEST_TYPES: ReadonlySet<ContextRequest["type"]> = new Set(["source_file", "configuration", "directory_summary", "dependency_details", "documentation"]);
/** Files added per query-only request. */
const MAX_QUERY_MATCHES = 2;
const PROVIDER_ID = "context-request";

/** Validate and normalize a requested repository-relative path; returns a rejection reason or the path. */
export function checkRequestPath(raw: string): { path: string } | { reason: string } {
  const p = toPosix(raw.trim());
  if (!p) return { reason: "empty path" };
  if (p.includes("\0")) return { reason: "invalid path" };
  if (path.posix.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(raw) || p.startsWith("~")) return { reason: "absolute paths are not allowed; use a repository-relative path" };
  const normalized = path.posix.normalize(p).replace(/\/+$/, "");
  if (normalized === ".." || normalized.startsWith("../") || p.split("/").includes("..")) return { reason: "path traversal outside the repository root is not allowed" };
  const clean = normalized === "" ? "." : normalized;
  if (isSensitivePath(clean)) return { reason: "sensitive file (secrets/credentials) cannot be read" };
  if (isExcludedPath(clean)) return { reason: "path is inside an excluded directory" };
  return { path: clean };
}

function kindFor(type: ContextRequest["type"]): EvidenceKind {
  switch (type) {
    case "source_file":
      return "source_file";
    case "documentation":
      return "documentation";
    case "directory_summary":
      return "directory";
    case "dependency_details":
      return "dependency";
    default:
      return "configuration";
  }
}

function requestEvidence(type: ContextRequest["type"], source: string, claim: string, value?: Record<string, unknown>): DiscoveryEvidence {
  const kind = kindFor(type);
  return {
    id: evidenceId(PROVIDER_ID, kind, source, claim),
    providerId: PROVIDER_ID,
    kind,
    priority: "P1",
    claim,
    source,
    ...(value ? { value } : {}),
    confidence: 1,
  };
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/**
 * §5.5 Targeted context requests: fulfil each request with a bounded, targeted read (no repository
 * rescan) and return a NEW packet. Traversal, sensitive and excluded paths are rejected with a reason.
 */
export async function applyContextRequests(input: ApplyContextRequestsInput): Promise<ApplyContextRequestsResult> {
  const limits = resolveLimits(input.limits);
  const budget = limits.contextTokenBudget;
  const root = path.resolve(input.root);
  const packet: ContextPacket = structuredClone(input.packet);
  const tracker = new LimitTracker(packet.discoveryLimits, contentBytes(packet));
  const fulfilled: ContextRequest[] = [];
  const rejected: ApplyContextRequestsResult["rejected"] = [];
  const requestedPaths = new Set<string>();
  let index = input.fileIndex;
  const getIndex = async () => (index ??= await buildFileIndex(root));

  const reject = (request: ContextRequest, reason: string) => rejected.push({ request, reason });
  const addEvidence = (e: DiscoveryEvidence) => {
    if (!packet.evidence.some((x) => x.id === e.id)) packet.evidence.push(e);
  };
  const hasContent = (p: string) =>
    packet.sourceFiles.some((f) => f.path === p) ||
    packet.instructions.some((i) => i.path === p && i.content !== undefined) ||
    packet.configuration.some((c) => c.path === p && c.content !== undefined);

  /** Evict the lowest-priority source excerpt that was not itself requested. */
  const evictOne = (why: string): boolean => {
    for (let i = packet.sourceFiles.length - 1; i >= 0; i--) {
      const f = packet.sourceFiles[i];
      if (!f || requestedPaths.has(f.path)) continue;
      packet.sourceFiles.splice(i, 1);
      tracker.reason(`${f.path}: excerpt evicted to make room (${why}) for a required context request`);
      tracker.truncated = true;
      packet.discoveryLimits = tracker.toJSON();
      return true;
    }
    return false;
  };

  /** Token room available for new content; evicts unrequested source excerpts for required requests. */
  const roomFor = (required: boolean): number => {
    const measure = () => budget - measurePacket(packet, budget) - ENTRY_OVERHEAD_TOKENS - 32;
    let room = measure();
    while (required && room < MIN_USEFUL_TOKENS * 4 && evictOne("tokens")) room = measure();
    return room;
  };

  /** Bounded read of one file into the packet; returns a rejection reason on failure. */
  const readInto = async (request: ContextRequest, rel: string): Promise<string | undefined> => {
    if (hasContent(rel)) return undefined; // already present
    if (contentFileCount(packet) >= limits.maxFiles && !(request.priority === "required" && evictOne("maxFiles"))) return `maxFiles limit (${limits.maxFiles}) reached`;
    const bytesLeft = limits.maxTotalBytes - contentBytes(packet);
    if (bytesLeft <= 0) return `maxTotalBytes limit (${limits.maxTotalBytes}) reached`;
    const room = roomFor(request.priority === "required");
    if (room < MIN_USEFUL_TOKENS) return "context token budget exhausted";
    const r = await readRedacted(root, rel, Math.min(limits.maxFileBytes, bytesLeft));
    if ("skipped" in r) {
      const why: Record<string, string> = {
        sensitive: "sensitive file (secrets/credentials) cannot be read",
        excluded: "path is inside an excluded directory",
        outside_root: "path resolves outside the repository root",
        binary: "binary file",
        not_found: "file not found",
        not_file: "not a regular file",
        error: "file could not be read",
      };
      return why[r.skipped] ?? "file could not be read";
    }
    const fitted = fitContent(r.content, room);
    const truncated = r.truncated || fitted.truncated;
    if (truncated) {
      tracker.truncated = true;
      tracker.reason(`${rel}: requested content truncated to fit limits`);
    }
    tracker.filesRead++;
    tracker.bytesUsed += byteLength(fitted.text);
    requestedPaths.add(rel);
    const reason = `requested (${request.priority}): ${redactSecrets(request.reason).text}`.slice(0, 300);
    if (request.type === "configuration") {
      const existing = packet.configuration.find((c) => c.path === rel);
      if (existing) existing.content = fitted.text;
      else packet.configuration.push({ path: rel, summary: reason, content: fitted.text });
    } else {
      packet.sourceFiles.push({ path: rel, content: fitted.text, truncated, reason: request.type === "documentation" ? `documentation ${reason}` : reason });
    }
    addEvidence(requestEvidence(request.type, rel, `Content of ${rel} added on ${request.type} request`, { requested: true }));
    packet.discoveryLimits = tracker.toJSON();
    return undefined;
  };

  // Required requests first; stable otherwise.
  const ordered = input.requests.map((r, i) => ({ r, i })).sort((a, b) => Number(a.r?.priority !== "required") - Number(b.r?.priority !== "required") || a.i - b.i);

  for (const { r: request } of ordered) {
    if (!request || typeof request !== "object" || !REQUEST_TYPES.has(request.type)) {
      reject(request, "unsupported request type");
      continue;
    }
    let rel: string | undefined;
    if (request.path !== undefined) {
      const checked = checkRequestPath(request.path);
      if ("reason" in checked) {
        reject(request, checked.reason);
        continue;
      }
      rel = checked.path;
    }
    const query = request.query?.trim();

    switch (request.type) {
      case "source_file":
      case "configuration":
      case "documentation": {
        let targets: string[];
        if (rel) targets = [rel];
        else if (query) {
          const files = await getIndex();
          const pool = files.filter((f) => (request.type === "documentation" ? isDocumentationPath(f) || /\.(md|mdx|rst|txt)$/i.test(f) : request.type === "source_file" ? isSourcePath(f) : !isSourcePath(f)));
          targets = rankPaths(pool.filter((f) => !hasContent(f)), extractKeywords(query), [], MAX_QUERY_MATCHES).map((s) => s.path);
          if (!targets.length) {
            reject(request, `no ${request.type.replace("_", " ")} matched query`);
            continue;
          }
        } else {
          reject(request, "request needs a path or a query");
          continue;
        }
        let failure: string | undefined;
        let added = 0;
        for (const t of targets) {
          const why = await readInto(request, t);
          if (why) failure ??= why;
          else added++;
        }
        if (added) fulfilled.push(request);
        else reject(request, failure ?? "nothing to add");
        break;
      }
      case "directory_summary": {
        const dir = rel ?? (query ? checkRequestPathOrUndefined(query) : undefined);
        if (!dir) {
          reject(request, "directory_summary needs a directory path");
          continue;
        }
        const files = (await getIndex()).filter((f) => dir === "." || f.startsWith(`${dir}/`));
        if (!files.length) {
          reject(request, "directory not found or empty");
          continue;
        }
        const summary = summarizeDirectory(dir, files);
        const existing = packet.configuration.find((c) => c.path === dir);
        if (existing) existing.summary = summary;
        else packet.configuration.push({ path: dir, summary });
        if (!packet.structure.relevantDirectories.includes(dir)) packet.structure.relevantDirectories.push(dir);
        addEvidence(requestEvidence("directory_summary", dir, `Directory ${dir} contains ${files.length} files`, { files: files.length }));
        requestedPaths.add(dir);
        fulfilled.push(request);
        break;
      }
      case "dependency_details": {
        const name = query ?? (rel && !rel.includes(".") ? rel : undefined);
        if (!name) {
          // Path-only: treat as a manifest read.
          if (!rel) {
            reject(request, "dependency_details needs a query (dependency name) or a manifest path");
            continue;
          }
          const why = await readInto({ ...request, type: "configuration" }, rel);
          if (why) reject(request, why);
          else fulfilled.push(request);
          break;
        }
        const details = dependencyDetails(packet.evidence, name, rel);
        if (!details.length) {
          reject(request, `dependency "${name}" not found in discovered manifests`);
          continue;
        }
        for (const d of details) {
          const summary = `${name}: ${d.lines.join("; ")}`;
          const existing = packet.configuration.find((c) => c.path === d.source);
          if (existing) existing.summary = existing.summary?.includes(summary) ? existing.summary : `${existing.summary ? `${existing.summary}; ` : ""}${summary}`;
          else packet.configuration.push({ path: d.source, summary });
          addEvidence(requestEvidence("dependency_details", d.source, `Dependency ${name} declared in ${d.source}: ${d.lines.join("; ")}`, { name }));
        }
        fulfilled.push(request);
        break;
      }
    }
  }

  packet.evidence.sort(compareEvidence);
  enforceTokenBudget(packet, budget, tracker, requestedPaths);
  packet.discoveryLimits = tracker.toJSON();
  finalizeTokens(packet);
  return { packet, fulfilled, rejected };
}

function checkRequestPathOrUndefined(q: string): string | undefined {
  const c = checkRequestPath(q);
  return "path" in c ? c.path : undefined;
}

function summarizeDirectory(dir: string, files: string[]): string {
  const prefix = dir === "." ? "" : `${dir}/`;
  const subdirs = new Map<string, number>();
  const exts = new Map<string, number>();
  const direct: string[] = [];
  for (const f of files) {
    const rest = f.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash > 0) subdirs.set(rest.slice(0, slash), (subdirs.get(rest.slice(0, slash)) ?? 0) + 1);
    else direct.push(rest);
    const dot = rest.lastIndexOf(".");
    if (dot > rest.lastIndexOf("/") && dot > 0) {
      const e = rest.slice(dot + 1).toLowerCase();
      exts.set(e, (exts.get(e) ?? 0) + 1);
    }
  }
  const top = (m: Map<string, number>, n: number) =>
    [...m]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, n)
      .map(([k, v]) => `${k} (${v})`)
      .join(", ");
  const parts = [`${files.length} files`];
  if (subdirs.size) parts.push(`subdirectories: ${top(subdirs, 20)}`);
  if (exts.size) parts.push(`extensions: ${top(exts, 10)}`);
  if (direct.length) parts.push(`files: ${direct.sort().slice(0, 25).join(", ")}${direct.length > 25 ? ", …" : ""}`);
  return parts.join("; ");
}

function dependencyDetails(evidence: DiscoveryEvidence[], name: string, manifest?: string): Array<{ source: string; lines: string[] }> {
  const needle = name.toLowerCase();
  const out = new Map<string, Set<string>>();
  const add = (source: string, line: string) => {
    if (manifest && source !== manifest) return;
    const s = out.get(source) ?? new Set<string>();
    s.add(line);
    out.set(source, s);
  };
  for (const e of evidence) {
    const v = rec(e.value);
    if (e.kind === "dependency") {
      for (const [scope, group] of Object.entries(v)) {
        const g = rec(group);
        for (const [dep, spec] of Object.entries(g)) {
          if (dep.toLowerCase() === needle || dep.toLowerCase().endsWith(`:${needle}`) || dep.toLowerCase().endsWith(`/${needle}`)) add(e.source, `${dep} ${String(spec)} (${scope})`);
        }
      }
    } else if (e.kind === "framework" || e.kind === "tooling") {
      const pkg = typeof v.package === "string" ? v.package.toLowerCase() : "";
      const nm = typeof v.name === "string" ? v.name.toLowerCase() : "";
      if (pkg === needle || nm === needle) add(e.source, e.claim);
    }
  }
  return [...out].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([source, lines]) => ({ source, lines: [...lines] }));
}

