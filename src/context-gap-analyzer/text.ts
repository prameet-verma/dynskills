import { sha256 } from "../core/index.js";

/**
 * Deterministic lexical utilities shared by the gap analyzer and the clarification manager.
 * No model calls: the same input always yields the same tokens, scores and ids.
 */

const STOPWORDS = new Set(
  (
    // English function words
    "a an and are as at be been being but by can could did do does doing done for from had has have having " +
    "he her here hers him his how i if in into is it its itself just me my no nor not of off on once only or " +
    "other our ours out over own same she should so some such than that the their theirs them then there these " +
    "they this those through to too under until up very was we were what when where which while who whom why " +
    "will with would you your yours yourself about above after again against all am any because before below " +
    "between both down during each few further more most also via per etc may might must shall let lets us " +
    // generic task / engineering verbs and nouns that carry no domain signal
    "use uses used using add adds added adding implement implementing create creating make making update " +
    "updating change changing fix fixing write writing new existing code project repo repository codebase " +
    "file files function functions feature features support supporting work working task tasks need needs " +
    "want wants get set like help skill skills"
  ).split(/\s+/),
);

/** Light, deterministic suffix stemming (enough to align "payments"/"payment", "integrating"/"integration"). */
export function stem(word: string): string {
  let w = word;
  if (w.length > 4 && w.endsWith("ies")) w = `${w.slice(0, -3)}y`;
  else if (w.endsWith("sses")) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us") && !w.endsWith("is")) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 5 && w.endsWith("ed")) w = w.slice(0, -2);
  if (w.length > 7 && w.endsWith("ation")) w = w.slice(0, -3);
  if (w.length > 3 && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}

/** Tokenize: split camelCase and non-alphanumerics, lowercase, drop stopwords and 1-char tokens, stem. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const spaced = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  for (const raw of spaced.split(/[^a-z0-9]+/)) {
    if (raw.length < 2 || STOPWORDS.has(raw)) continue;
    const s = stem(raw);
    if (s.length < 2 || STOPWORDS.has(s)) continue;
    out.push(s);
  }
  return out;
}

export function tokenSet(...texts: Array<string | undefined>): Set<string> {
  const set = new Set<string>();
  for (const t of texts) if (t) for (const tok of tokenize(t)) set.add(tok);
  return set;
}

export function intersectionSize(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n;
}

/** Canonical form of a question used for de-duplication across rounds ("previously asked/declined"). */
export function normalizeQuestion(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s?.!:;,]+$/u, "");
}

export function shortHash(text: string): string {
  return sha256(text).slice(0, 12);
}

/** Deterministic clarification question id: "q_" + short hash of the normalized question text. */
export function questionId(question: string): string {
  return `q_${shortHash(normalizeQuestion(question))}`;
}
