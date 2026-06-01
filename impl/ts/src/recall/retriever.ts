import type { Embedder } from "../memory/embedder.js";
import { cosine } from "../memory/embedder.js";
import type { MemoryStore } from "../memory/store.js";
import type { MemoryRecord } from "../memory/types.js";
import type { EntityIndex } from "../memory/entity-index.js";
import type { EntityTagger } from "../ingest/entity-tagger.js";

export interface RetrieverOptions {
  scopeTags: string[];
  k?: number;
  maxHops?: number;
  frontierCap?: number;
  bridgeFloor?: number;
}

export interface ScoredRecord { rec: MemoryRecord; score: number; hop: number; }

export interface Retriever {
  retrieve(query: string, opts: RetrieverOptions): Promise<ScoredRecord[]>;
}

/**
 * Seeded graph-expansion retriever (proposal 0004-B §5B). Seeds = dense top-k ∪
 * query-entity-anchored lookups; expands bounded hops over the EntityIndex to gather
 * bridge facts dense retrieval cannot reach. Scoring: hop-0 by query similarity;
 * hop>=1 by max(querySim, floor) where floor = min(bridgeFloor, topHop0Sim) so a
 * bridge never outranks the best seed (single-hop answer protection). Deterministic
 * order: score desc, hop asc, id asc. Every EntityIndex-sourced candidate is
 * scope-filtered (governance partition honored).
 */
export class GraphExpansionRetriever implements Retriever {
  private readonly embedder: Embedder;
  private readonly memory: MemoryStore;
  private readonly entityIndex: EntityIndex;
  private readonly tagger: EntityTagger;
  private readonly maxHops: number;
  private readonly frontierCap: number;
  private readonly bridgeFloor: number;
  constructor(opts: {
    embedder: Embedder; memory: MemoryStore; entityIndex: EntityIndex; tagger: EntityTagger;
    maxHops?: number; frontierCap?: number; bridgeFloor?: number;
  }) {
    this.embedder = opts.embedder; this.memory = opts.memory;
    this.entityIndex = opts.entityIndex; this.tagger = opts.tagger;
    this.maxHops = opts.maxHops ?? 2;
    this.frontierCap = opts.frontierCap ?? 4;
    this.bridgeFloor = opts.bridgeFloor ?? 0.5;
  }

  async retrieve(query: string, opts: RetrieverOptions): Promise<ScoredRecord[]> {
    if (opts.scopeTags.length === 0) {
      throw new Error("GraphExpansionRetriever.retrieve: scopeTags must be non-empty (governance partition required)");
    }
    const k = opts.k ?? 50;
    const maxHops = opts.maxHops ?? this.maxHops;
    const bridgeFloor = opts.bridgeFloor ?? this.bridgeFloor;
    const qEmb = this.embedder.embedQuery ? await this.embedder.embedQuery(query) : await this.embedder.embed(query);
    const inScope = (rec: MemoryRecord): boolean => opts.scopeTags.every((t) => rec.tags.includes(t));

    const recs = new Map<string, MemoryRecord>();
    const hop = new Map<string, number>();

    // (1) dense seeds — rely on MemoryStore.query's tag-AND to enforce the scope
    // partition (the recall-seam governance contract); entity-sourced candidates
    // below are additionally guarded by inScope().
    for (const { rec } of await this.memory.query({ embedding: qEmb, tags: opts.scopeTags, k })) {
      if (!recs.has(rec.id)) { recs.set(rec.id, rec); hop.set(rec.id, 0); }
    }
    // (2) query-entity-anchored seeds — deterministic first hop for named entities.
    for (const slug of this.tagger.tag(query)) {
      for (const id of this.entityIndex.lookup(slug)) {
        if (recs.has(id)) continue;
        const rec = await this.memory.getById(id);
        if (rec && inScope(rec)) { recs.set(id, rec); hop.set(id, 0); }
      }
    }
    // (3) bounded expansion over shared entities. recs.has() before insert keeps the
    // smallest hop and terminates cycles; `added` counts only NEW admissions so
    // frontierCap bounds per-node fan-out.
    const frontierCap = opts.frontierCap ?? this.frontierCap;
    let frontier = [...recs.keys()];
    for (let h = 1; h <= maxHops && frontier.length > 0; h++) {
      const next: string[] = [];
      for (const nodeId of frontier) {
        let added = 0;
        fanOut: for (const slug of this.entityIndex.slugsOf(nodeId)) {
          for (const nbr of this.entityIndex.lookup(slug)) {
            if (added >= frontierCap) break fanOut;
            if (recs.has(nbr)) continue;
            const rec = await this.memory.getById(nbr);
            if (rec && inScope(rec)) { recs.set(nbr, rec); hop.set(nbr, h); next.push(nbr); added++; }
          }
        }
      }
      frontier = next;
    }

    return this.rank(qEmb, recs, hop, bridgeFloor);
  }

  /** Score with a relative bridge floor + deterministic ordering. */
  protected rank(
    qEmb: number[], recs: Map<string, MemoryRecord>, hop: Map<string, number>, bridgeFloor: number,
  ): ScoredRecord[] {
    const sim = new Map<string, number>();
    let topHop0Sim = 0;
    for (const [id, rec] of recs) {
      const s = rec.embedding ? cosine(qEmb, rec.embedding) : 0;
      sim.set(id, s);
      if ((hop.get(id) ?? 0) === 0 && s > topHop0Sim) topHop0Sim = s;
    }
    const floor = Math.min(bridgeFloor, topHop0Sim);
    const scored: ScoredRecord[] = [];
    for (const [id, rec] of recs) {
      const h = hop.get(id) ?? 0;
      const s = sim.get(id) ?? 0;
      scored.push({ rec, score: h === 0 ? s : Math.max(s, floor), hop: h });
    }
    scored.sort((a, b) =>
      b.score - a.score || a.hop - b.hop || (a.rec.id < b.rec.id ? -1 : a.rec.id > b.rec.id ? 1 : 0),
    );
    return scored;
  }
}
