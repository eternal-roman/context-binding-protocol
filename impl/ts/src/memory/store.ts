import type { MemoryRecord } from "./types.js";
import { cosine } from "./embedder.js";

export interface MemoryQuery {
  embedding?: number[];   // dense query vector; results cosine-ranked
  tags?: string[];        // metadata filter (AND)
  k?: number;             // max candidates (default 50)
  // NOTE: ACL filtering is intentionally NOT done here. Governance is applied
  // upstream by the existing fail-closed ACL/inheritance filter at candidate
  // generation (Phase 3) — design §7 dec. 9. Temporal (asOf) filtering arrives
  // with bi-temporal fields (Phase 5). Keeping both out of the index avoids a
  // second governance mechanism and keeps its posture consistent.
}

export interface MemoryStore {
  upsert(rec: MemoryRecord): Promise<void>;
  getById(id: string): Promise<MemoryRecord | undefined>;
  query(q: MemoryQuery): Promise<Array<{ rec: MemoryRecord; score: number }>>;
  delete(id: string): Promise<boolean>;
}

/**
 * Shallow-clone a record (and its nested arrays/objects) so callers cannot
 * mutate the store's copy by reference. MemoryRecord is a read-only projection;
 * the store is the query surface, not a handle into mutable internal state.
 */
function cloneRecord(rec: MemoryRecord): MemoryRecord {
  return {
    ...rec,
    fidelities: { ...rec.fidelities },
    tokenCost: { ...rec.tokenCost },
    tags: [...rec.tags],
    embedding: rec.embedding ? [...rec.embedding] : rec.embedding,
  };
}

export class InMemoryMemoryStore implements MemoryStore {
  private readonly recs = new Map<string, MemoryRecord>();
  async upsert(rec: MemoryRecord): Promise<void> { this.recs.set(rec.id, cloneRecord(rec)); }
  async getById(id: string): Promise<MemoryRecord | undefined> {
    const rec = this.recs.get(id);
    return rec ? cloneRecord(rec) : undefined;
  }
  async delete(id: string): Promise<boolean> { return this.recs.delete(id); }
  async query(q: MemoryQuery): Promise<Array<{ rec: MemoryRecord; score: number }>> {
    // Clamp k to a positive integer; a negative/zero/float k would otherwise
    // turn slice(0, k) into a silent contract violation (e.g. slice(0,-1)).
    const k = Number.isInteger(q.k) && (q.k as number) > 0 ? (q.k as number) : 50;
    const out: Array<{ rec: MemoryRecord; score: number }> = [];
    for (const rec of this.recs.values()) {
      if (q.tags && !q.tags.every((t) => rec.tags.includes(t))) continue;
      let score: number;
      if (q.embedding) {
        if (!rec.embedding) {
          // Under a vector query, an unembedded record cannot be scored
          // semantically. Score it 0 — do NOT fall back to its weight, or a
          // high-w unembedded record would outrank genuine matches.
          score = 0;
        } else if (rec.embedding.length !== q.embedding.length) {
          throw new RangeError(
            `MemoryStore.query: embedding dim mismatch (query ${q.embedding.length} vs ` +
            `record ${rec.id} ${rec.embedding.length}) — mixed embedders in one store?`
          );
        } else {
          score = cosine(q.embedding, rec.embedding);
        }
      } else {
        score = rec.w; // structural fallback when no query vector is given
      }
      out.push({ rec, score });
    }
    out.sort((a, b) => b.score - a.score);
    // Clone on the way out so a caller cannot mutate the store's records by ref.
    return out.slice(0, k).map(({ rec, score }) => ({ rec: cloneRecord(rec), score }));
  }
}
