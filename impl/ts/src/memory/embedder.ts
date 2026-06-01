export interface Embedder {
  readonly modelId: string;
  readonly dim: number;
  /** Embed a document/passage (the corpus-side contract projectNode relies on). */
  embed(text: string): Promise<number[]>;
  /**
   * Optional asymmetric QUERY embedding. Models like bge embed queries with a
   * short retrieval instruction that documents do not get — a real quality
   * lever. RecallPipeline uses this when present, falling back to `embed`.
   */
  embedQuery?(text: string): Promise<number[]>;
}

export function cosine(a: number[], b: number[]): number {
  // Equal length is a precondition: comparing different-dimension vectors is
  // undefined and almost always signals mixed embedders. Fail loudly rather
  // than silently scoring over a truncated prefix.
  if (a.length !== b.length) {
    throw new RangeError(`cosine: vector length mismatch (${a.length} vs ${b.length})`);
  }
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    dot += x * y; na += x * x; nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Deterministic bag-of-words hashing embedder. NOT for production retrieval
// quality — it is the DEPENDENCY-FREE DEFAULT so the memory layer is testable
// with zero deps and no model download. Real models (local Transformers.js;
// hosted Voyage) land behind this same interface. Per design §7 dec. 10, no
// heavy embedder is ever the default.
export class HashingEmbedder implements Embedder {
  readonly modelId: string;
  constructor(readonly dim = 256) { this.modelId = `hashing-v1@${dim}`; }
  async embed(text: string): Promise<number[]> {
    const v = new Array(this.dim).fill(0);
    for (const tok of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
      let h = 2166136261 >>> 0;
      for (let i = 0; i < tok.length; i++) { h ^= tok.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
      v[h % this.dim] += 1;
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  }
}
