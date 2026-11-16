import type { ContextPacket, DiscoveryEvidence, DiscoveryLimits } from "../contracts/index.js";
import { DEFAULT_CONFIG } from "../contracts/index.js";
import { estimateTokens, readTextFileBounded, redactSecrets, stableStringify, truncateToTokens, type SkipReason } from "../core/index.js";

/** §5.3 defaults: 30 files / 64 KB per file / 512 KB total / ~12,000 tokens. */
export const DEFAULT_DISCOVERY_LIMITS: DiscoveryLimits = {
  maxFiles: DEFAULT_CONFIG.discovery.maximumFiles,
  maxFileBytes: DEFAULT_CONFIG.discovery.maximumFileBytes,
  maxTotalBytes: DEFAULT_CONFIG.discovery.maximumTotalBytes,
  contextTokenBudget: DEFAULT_CONFIG.discovery.contextTokenBudget,
  providerTimeoutMs: DEFAULT_CONFIG.discovery.providerTimeoutMs,
  concurrency: DEFAULT_CONFIG.discovery.concurrency,
};

/** Content smaller than this after truncation is not worth including. */
export const MIN_USEFUL_TOKENS = 40;
/** Per-entry JSON overhead (keys, quotes, flags) when adding a content file. */
export const ENTRY_OVERHEAD_TOKENS = 24;
export const MAX_REASONS = 40;

export function resolveLimits(limits: Partial<DiscoveryLimits> | undefined): DiscoveryLimits {
  const pick = (k: keyof DiscoveryLimits): number => {
    const v = limits?.[k];
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : DEFAULT_DISCOVERY_LIMITS[k];
  };
  return {
    maxFiles: pick("maxFiles"),
    maxFileBytes: pick("maxFileBytes"),
    maxTotalBytes: pick("maxTotalBytes"),
    contextTokenBudget: pick("contextTokenBudget"),
    providerTimeoutMs: pick("providerTimeoutMs"),
    concurrency: pick("concurrency"),
  };
}

/** Stable JSON used for token estimates and hand-off (sorted keys). */
export function serializePacket(packet: ContextPacket): string {
  return stableStringify(packet);
}

/**
 * Token size of the packet as it will be serialized. Measured with `estimatedTokens` set to the budget
 * (an upper bound on its digits) so that writing the final number never pushes the packet over budget.
 */
export function measurePacket(packet: ContextPacket, budget: number): number {
  const prev = packet.estimatedTokens;
  packet.estimatedTokens = Math.max(budget, prev);
  const t = estimateTokens(serializePacket(packet));
  packet.estimatedTokens = prev;
  return t;
}

export function finalizeTokens(packet: ContextPacket): void {
  packet.estimatedTokens = 0;
  // Iterate to a fixed point: the number's own digits contribute to the estimate.
  for (let i = 0; i < 4; i++) {
    const t = estimateTokens(serializePacket(packet));
    if (t === packet.estimatedTokens) break;
    packet.estimatedTokens = t;
  }
}

/** Tokens a string costs once JSON-escaped. */
export function jsonTokens(s: string): number {
  return estimateTokens(JSON.stringify(s));
}

/** Truncate content so its JSON-escaped token cost is ≤ maxTokens. */
export function fitContent(content: string, maxTokens: number): { text: string; truncated: boolean } {
  if (jsonTokens(content) <= maxTokens) return { text: content, truncated: false };
  let target = maxTokens;
  let out = truncateToTokens(content, target);
  for (let i = 0; i < 6 && jsonTokens(out.text) > maxTokens; i++) {
    target = Math.floor((target * maxTokens) / Math.max(1, jsonTokens(out.text))) - 1;
    if (target <= 0) return { text: "", truncated: true };
    out = truncateToTokens(content, target);
  }
  return { text: out.text, truncated: true };
}

export function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/** Cut a string to at most maxBytes UTF-8 bytes without splitting a character. */
export function cutToBytes(s: string, maxBytes: number): string {
  if (byteLength(s) <= maxBytes) return s;
  return Buffer.from(s, "utf8").subarray(0, maxBytes).toString("utf8").replace(/�$/, "");
}

export type SafeRead = { content: string; truncated: boolean } | { skipped: SkipReason | "error"; path: string };

/**
 * Bounded, redacted read. Reads a small slack beyond the byte cap so secrets straddling the cut are
 * still recognised by redaction, then cuts to the cap.
 */
export async function readRedacted(root: string, rel: string, maxBytes: number): Promise<SafeRead> {
  const slack = 512;
  const r = await readTextFileBounded(root, rel, maxBytes + slack).catch(() => ({ skipped: "error" as const, path: rel }));
  if ("skipped" in r) return r;
  const redacted = redactSecrets(r.content).text;
  const cut = cutToBytes(redacted, maxBytes);
  return { content: cut, truncated: r.truncated || cut.length < redacted.length };
}

/** Redact a copy of an evidence entry's free-text fields. */
export function sanitizeEvidence(e: DiscoveryEvidence): DiscoveryEvidence {
  const copy = structuredClone(e);
  copy.claim = redactSecrets(copy.claim).text;
  if (copy.excerpt !== undefined) copy.excerpt = redactSecrets(copy.excerpt).text;
  if (typeof copy.value === "string") copy.value = redactSecrets(copy.value).text;
  else if (copy.value && typeof copy.value === "object") {
    copy.value = JSON.parse(redactSecrets(JSON.stringify(copy.value)).text) as Record<string, unknown>;
  }
  return copy;
}

export class LimitTracker {
  filesRead: number;
  filesSkipped: number;
  truncated: boolean;
  bytesUsed: number;
  readonly reasons: string[];
  private readonly reasonSet: Set<string>;

  constructor(init: ContextPacket["discoveryLimits"] = { filesRead: 0, filesSkipped: 0, truncated: false, reasons: [] }, bytesUsed = 0) {
    this.filesRead = init.filesRead;
    this.filesSkipped = init.filesSkipped;
    this.truncated = init.truncated;
    this.reasons = [...init.reasons];
    this.reasonSet = new Set(this.reasons);
    this.bytesUsed = bytesUsed;
  }

  reason(r: string): void {
    if (this.reasonSet.has(r)) return;
    this.reasonSet.add(r);
    if (this.reasons.length < MAX_REASONS) this.reasons.push(r);
    else if (this.reasons.length === MAX_REASONS) this.reasons.push("additional limit reasons omitted");
  }

  toJSON(): ContextPacket["discoveryLimits"] {
    return { filesRead: this.filesRead, filesSkipped: this.filesSkipped, truncated: this.truncated, reasons: [...this.reasons] };
  }
}

/** Number of packet entries that carry file content. */
export function contentFileCount(p: ContextPacket): number {
  return p.instructions.filter((i) => i.content !== undefined).length + p.configuration.filter((c) => c.content !== undefined).length + p.sourceFiles.length;
}

export function contentBytes(p: ContextPacket): number {
  let n = 0;
  for (const i of p.instructions) if (i.content) n += byteLength(i.content);
  for (const c of p.configuration) if (c.content) n += byteLength(c.content);
  for (const s of p.sourceFiles) n += byteLength(s.content);
  return n;
}

/** Order in which non-P0 evidence is dropped under budget pressure (lower drops first). */
function dropRank(e: DiscoveryEvidence, includedPaths: Set<string>): number {
  const pr = e.priority === "P2" ? 0 : 10;
  const kind = e.kind === "documentation" ? 0 : e.kind === "ci_cd" ? 1 : e.kind === "source_file" ? (includedPaths.has(e.source) ? 4 : 2) : 3;
  return pr + kind;
}

/**
 * Bring the packet within the token budget by removing the lowest-priority material first:
 * non-P0 excerpts → source excerpts (last first) → configuration contents → non-P0 evidence →
 * instruction contents → P0 excerpts. P0 evidence entries are never dropped.
 */
export function enforceTokenBudget(
  packet: ContextPacket,
  budget: number,
  tracker: LimitTracker,
  protectedSources: ReadonlySet<string> = new Set(),
  summaries: ReadonlyMap<string, string> = new Map(),
): void {
  packet.discoveryLimits = tracker.toJSON();
  let tokens = measurePacket(packet, budget);
  if (tokens <= budget) return;
  const over = () => tokens > budget;
  const remeasure = () => {
    packet.discoveryLimits = tracker.toJSON();
    return (tokens = measurePacket(packet, budget));
  };
  tracker.truncated = true;

  // 1. Strip excerpts from non-P0 evidence.
  for (const e of packet.evidence) if (e.priority !== "P0" && e.excerpt !== undefined) delete e.excerpt;
  if (remeasure() <= budget) return;

  const shrink = (getContent: () => string, setContent: (s: string | undefined, truncated: boolean) => void, label: string): void => {
    const content = getContent();
    const cost = jsonTokens(content);
    const target = cost - (tokens - budget) - 8;
    if (target < MIN_USEFUL_TOKENS) {
      setContent(undefined, true);
      tracker.reason(`${label}: content dropped to fit context token budget`);
    } else {
      setContent(fitContent(content, target).text, true);
      tracker.reason(`${label}: truncated to fit context token budget`);
    }
    remeasure();
  };

  // 2. Source excerpts, lowest priority (end of list) first; protected (requested) ones last.
  const sourceOrder = () => {
    const idx = packet.sourceFiles.map((_, i) => i);
    const prot = (i: number) => Number(protectedSources.has(packet.sourceFiles[i]?.path ?? ""));
    return idx.sort((a, b) => prot(a) - prot(b) || b - a);
  };
  while (over() && packet.sourceFiles.length) {
    const i = sourceOrder()[0] as number;
    const f = packet.sourceFiles[i];
    if (!f || protectedSources.has(f.path)) break;
    shrink(
      () => f.content,
      (s) => {
        if (s === undefined) packet.sourceFiles.splice(i, 1);
        else {
          f.content = s;
          f.truncated = true;
        }
      },
      f.path,
    );
  }
  // 3. Configuration contents → summaries only (last first).
  for (let i = packet.configuration.length - 1; i >= 0 && over(); i--) {
    const c = packet.configuration[i];
    if (!c || c.content === undefined || protectedSources.has(c.path)) continue;
    delete c.content;
    if (!c.summary) c.summary = summaries.get(c.path) ?? "content omitted to fit context token budget";
    tracker.reason(`${c.path}: configuration content replaced by summary to fit context token budget`);
    remeasure();
  }
  // 4. Non-P0 evidence.
  if (over()) {
    const included = new Set(packet.sourceFiles.map((s) => s.path));
    const candidates = packet.evidence
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e.priority !== "P0" && !protectedSources.has(e.source))
      .sort((a, b) => dropRank(a.e, included) - dropRank(b.e, included) || b.i - a.i);
    const drop = new Set<string>();
    let dropped = 0;
    for (const { e } of candidates) {
      if (!over()) break;
      drop.add(e.id);
      dropped++;
      // Re-measure in batches to keep this linear-ish.
      if (dropped % 5 === 0 || dropped === candidates.length) {
        packet.evidence = packet.evidence.filter((x) => !drop.has(x.id));
        remeasure();
      }
    }
    packet.evidence = packet.evidence.filter((x) => !drop.has(x.id));
    remeasure();
    if (dropped) tracker.reason(`${dropped} non-P0 evidence entries dropped to fit context token budget`);
  }
  // 5. Instruction contents (last first).
  for (let i = packet.instructions.length - 1; i >= 0 && over(); i--) {
    const ins = packet.instructions[i];
    if (!ins || ins.content === undefined) continue;
    shrink(
      () => ins.content ?? "",
      (s) => {
        if (s === undefined) delete ins.content;
        else ins.content = s;
      },
      ins.path,
    );
  }
  // 6. Remaining sources/config protected by requests.
  while (over() && packet.sourceFiles.length) {
    const f = packet.sourceFiles[packet.sourceFiles.length - 1] as ContextPacket["sourceFiles"][number];
    shrink(
      () => f.content,
      (s) => {
        if (s === undefined) packet.sourceFiles.pop();
        else f.content = s;
      },
      f.path,
    );
  }
  for (const c of packet.configuration) {
    if (!over()) break;
    if (c.content !== undefined) {
      delete c.content;
      remeasure();
    }
  }
  // 7. P0 excerpts (entries themselves are kept).
  if (over()) {
    for (const e of packet.evidence) delete e.excerpt;
    remeasure();
    if (over()) tracker.reason("P0 evidence alone exceeds the context token budget; P0 entries were kept");
    else tracker.reason("P0 evidence excerpts removed to fit context token budget");
  }
  packet.discoveryLimits = tracker.toJSON();
}
