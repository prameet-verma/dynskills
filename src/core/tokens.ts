/**
 * Approximate token count. Deliberately dependency-free: ~4 characters per token for
 * English/code is accurate enough for budgets, and conservative for CJK-heavy text.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let nonAscii = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 127) nonAscii++;
  const ascii = text.length - nonAscii;
  return Math.ceil(ascii / 4 + nonAscii);
}

/** Truncate text so that estimateTokens(result) <= maxTokens, cutting at a line boundary when possible. */
export function truncateToTokens(text: string, maxTokens: number): { text: string; truncated: boolean } {
  if (estimateTokens(text) <= maxTokens) return { text, truncated: false };
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(text.slice(0, mid)) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  let cut = text.slice(0, lo);
  const nl = cut.lastIndexOf("\n");
  if (nl > lo * 0.6) cut = cut.slice(0, nl);
  return { text: cut, truncated: true };
}
