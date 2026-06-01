/** Canonical entity slug: lowercase, non-alphanumeric runs → single hyphen, trimmed. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/['']s\b/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export interface EntityTagger {
  /** Canonical entity slugs mentioned in the fact text, de-duplicated. */
  tag(text: string): string[];
}

// Dropped when a capitalized span consists ENTIRELY of these (lowercased):
// articles/prepositions/question-words that get capitalized sentence-initially,
// plus role words that are not entities.
const STOPWORDS = new Set<string>([
  "the", "a", "an", "in", "on", "at", "of", "to", "and", "or", "but", "for", "with", "by", "from",
  "what", "where", "which", "who", "whom", "when", "why", "how",
  "is", "are", "was", "were", "be", "been", "has", "have", "had", "do", "does", "did",
  "this", "that", "these", "those", "it", "its", "i", "you", "he", "she", "they", "we",
  "ceo", "cto", "coo", "cfo", "cmo", "cio", "vp", "president", "director", "manager",
  "founder", "chair", "chairman", "head",
]);

/** Strip leading/trailing non-alphanumerics from a single word ("Robotics." → "Robotics"). */
function stripEdgePunct(word: string): string {
  return word.replace(/^[^A-Za-z0-9]+/, "").replace(/[^A-Za-z0-9]+$/, "");
}

/**
 * Dependency-free heuristic tagger: group maximal runs of capitalized words into
 * candidate entity spans, drop spans made entirely of stopwords/role-words, slugify.
 * Accuracy is a MEASURED, imperfect quantity (a lowercase-tailed name like
 * "Atlas survey drone" reduces to "atlas") — see proposal 0004-B §5A.
 */
export class HeuristicEntityTagger implements EntityTagger {
  tag(text: string): string[] {
    const words = text.split(/\s+/).map(stripEdgePunct).filter(Boolean);
    const spans: string[][] = [];
    let run: string[] = [];
    for (const w of words) {
      if (/^[A-Z]/.test(w)) {
        run.push(w);
      } else if (run.length) {
        spans.push(run);
        run = [];
      }
    }
    if (run.length) spans.push(run);

    const isStop = (t: string): boolean => STOPWORDS.has(t.toLowerCase());
    const slugs = new Set<string>();
    for (const span of spans) {
      if (span.every(isStop)) continue;
      // Trim leading/trailing stopword tokens so a role/title prefix does not bleed
      // into the slug ("CEO Jane Doe" → "jane-doe", linkable with "Jane Doe").
      let start = 0;
      let end = span.length;
      while (start < end && isStop(span[start] ?? "")) start++;
      while (end > start && isStop(span[end - 1] ?? "")) end--;
      const slug = slugify(span.slice(start, end).join(" "));
      if (slug) slugs.add(slug);
    }
    return [...slugs].sort();
  }
}
