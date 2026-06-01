/**
 * Paragraph-window chunking for LLM extraction. Greedily packs whole paragraphs
 * (split on blank lines, trimmed, blanks dropped) into windows aimed at
 * <= maxChars, then caps the result at maxChunks (setting `truncated` if more
 * windows were produced than the cap). Best-effort on size: a single paragraph
 * longer than maxChars is emitted whole as its own over-size chunk rather than
 * split mid-paragraph.
 */
export function chunk(doc: string, maxChars = 5000, maxChunks = 8): { chunks: string[]; truncated: boolean } {
  if (maxChunks <= 0) return { chunks: [], truncated: false };
  const paras = doc.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let cur = "";
  for (const p of paras) {
    if (cur && cur.length + p.length + 2 > maxChars) { chunks.push(cur); cur = ""; }
    cur = cur ? `${cur}\n\n${p}` : p;
  }
  if (cur) chunks.push(cur);
  const truncated = chunks.length > maxChunks;
  return { chunks: chunks.slice(0, maxChunks), truncated };
}
