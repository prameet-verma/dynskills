/**
 * Small, dependency-free text utilities shared by the compiler and the eval engine
 * (keyword extraction, a light stemmer, set similarity).
 */

export const STOPWORDS: ReadonlySet<string> = new Set([
  "a", "about", "above", "after", "again", "all", "also", "an", "and", "any", "are", "as", "at",
  "be", "because", "been", "before", "being", "below", "between", "both", "but", "by",
  "can", "could", "did", "do", "does", "doing", "done", "down", "during",
  "each", "either", "etc", "every", "few", "for", "from", "further",
  "had", "has", "have", "having", "here", "how",
  "if", "in", "into", "is", "it", "its", "itself", "just",
  "may", "might", "more", "most", "must", "my", "need", "needs", "new", "no", "nor", "not", "now",
  "of", "off", "on", "once", "only", "or", "other", "our", "out", "over", "own",
  "please", "same", "should", "so", "some", "such",
  "than", "that", "the", "their", "them", "then", "there", "these", "they", "this", "those", "through", "to", "too",
  "under", "until", "up", "us", "use", "used", "uses", "using",
  "very", "via", "was", "we", "were", "what", "when", "where", "which", "while", "who", "whom", "why", "will", "with", "within", "without", "would",
  "you", "your", "yours",
]);

/** Lowercase alphanumeric words. */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/**
 * Deliberately crude, deterministic suffix stripper (Porter-lite). It only needs to map
 * inflections of the same word onto one key ("tests"/"testing"/"tested" → "test").
 */
export function stem(word: string): string {
  let w = word.toLowerCase();
  if (w.length > 4 && w.endsWith("ies")) w = `${w.slice(0, -3)}y`;
  else if (w.endsWith("sses")) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us")) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
  if (w.length > 4 && w.endsWith("e")) w = w.slice(0, -1);
  if (w.length > 3 && w.endsWith("y")) w = `${w.slice(0, -1)}i`;
  return w;
}

/** Significant (non-stopword) words in original order, unstemmed, unique. */
export function significantWords(text: string, minLength = 3): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokenize(text)) {
    if (t.length < minLength || STOPWORDS.has(t) || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** Unique stemmed keywords (stopwords and short tokens removed). */
export function keywords(text: string, minLength = 3): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of significantWords(text, minLength)) {
    const s = stem(w);
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

export function keywordSet(text: string): Set<string> {
  return new Set(keywords(text));
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Fraction of `needle` keywords present in `haystack` (0 when needle is empty). */
export function coverage(needle: ReadonlySet<string>, haystack: ReadonlySet<string>): number {
  if (needle.size === 0) return 0;
  let hit = 0;
  for (const x of needle) if (haystack.has(x)) hit++;
  return hit / needle.size;
}

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Truncate to at most `max` characters, cutting at a word boundary when possible. */
export function truncateAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  const out = space > max * 0.5 ? cut.slice(0, space) : cut;
  return out.replace(/[\s,;:]+$/, "");
}

export function stripTrailingPunctuation(text: string): string {
  return text.trim().replace(/[.;:,\s]+$/, "");
}

export function capitalize(text: string): string {
  return text.length === 0 ? text : text.charAt(0).toUpperCase() + text.slice(1);
}

/** True when a line is phrased as a prohibition ("Do not …", "Never …", "Must not …", "Avoid …"). */
export function isProhibition(line: string): boolean {
  const s = line
    .trim()
    .replace(/^(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/^[*_`>\s]+/, "")
    .toLowerCase();
  return /^(?:do not|don't|dont|never|must not|must never|should not|shouldn't|you must not|you must never|avoid|refuse to|no\s|not\s)/.test(
    s,
  );
}
