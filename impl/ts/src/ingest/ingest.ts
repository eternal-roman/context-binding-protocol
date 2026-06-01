import type { GraphStore } from "../graph/store.js";
import { MaxNodesExceededError } from "../graph/store.js";
import type { MemoryStore } from "../memory/store.js";
import type { Embedder } from "../memory/embedder.js";
import { projectNode } from "../memory/project.js";
import type { FidelityDeriver } from "../memory/fidelity.js";
import type { Tokenizer } from "../tokenizer/tokenizer.js";
import type { CbpNode, ResolvedNode } from "../types/node.js";
import { Fact } from "./types.js";
import type { IngestResult } from "./types.js";
import type { Extractor } from "./extract.js";
import type { EntityTagger } from "./entity-tagger.js";
import type { EntityIndex } from "../memory/entity-index.js";

function framePartitionTag(frameId: string): string { return `frame:${frameId}`; }

export class MemoryIngestor {
  private readonly graph: GraphStore;
  private readonly memory: MemoryStore;
  private readonly embedder: Embedder;
  private readonly deriver?: FidelityDeriver;
  private readonly entityTagger?: EntityTagger;
  private readonly entityIndex?: EntityIndex;
  constructor(opts: { graph: GraphStore; memory: MemoryStore; embedder: Embedder; deriver?: FidelityDeriver; entityTagger?: EntityTagger; entityIndex?: EntityIndex }) {
    this.graph = opts.graph; this.memory = opts.memory; this.embedder = opts.embedder; this.deriver = opts.deriver;
    this.entityTagger = opts.entityTagger; this.entityIndex = opts.entityIndex;
    if ((opts.entityTagger == null) !== (opts.entityIndex == null)) {
      throw new Error(
        "MemoryIngestor: entityTagger and entityIndex must be provided together or not at all",
      );
    }
  }

  /** Ensure the frame anchor node exists (deterministic content id; idempotent). Returns its REAL stored id. */
  private ensureAnchor(frameId: string): string {
    const content = { type: "frame" as const, val: { name: frameId }, lineage: null, tags: [] as string[] };
    const existing = this.graph.getNodeByContent(content);
    if (existing) return existing.id;
    try {
      // insertNode returns the node with the id it actually assigned (deriveUniqueId
      // may extend it on an 8-char prefix collision), so use node.id — never a
      // bare 8-char prefix, which could dangle the lineage of every fact.
      return this.graph.insertNode({ ...content, w: 1, decay: "none", ttl: null }).id;
    } catch (err) {
      if (err instanceof MaxNodesExceededError) throw err; // preserve type so the route can map it to 507
      throw new Error(
        `MemoryIngestor: cannot create frame anchor for "${frameId}": ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async ingestFacts(frameId: string, facts: unknown[], tokenizer: Tokenizer): Promise<IngestResult> {
    const anchorId = this.ensureAnchor(frameId);
    const partition = framePartitionTag(frameId);
    const nodeIds: string[] = [];
    const skipped: IngestResult["skipped"] = [];

    for (let i = 0; i < facts.length; i++) {
      const parsed = Fact.safeParse(facts[i]);
      if (!parsed.success) {
        skipped.push({ index: i, reason: parsed.error.issues[0]?.message ?? "invalid fact" });
        continue;
      }
      const f = parsed.data;
      // Server owns the partition: strip any client-supplied frame: tag, add ours.
      const tags = [...f.tags.filter((t) => !t.startsWith("frame:")), partition];
      try {
        // Collision-correct content dedup: getNodeByContent uses the full 64-char
        // hash, so a re-ingested fact reuses its existing node even when the
        // 8-char id prefix collided at first insert (insertNode uniquifies, it
        // does NOT NOOP). getNodeByContent / insertNode / projectNode all
        // canonicalize `val` and THROW on over-deep nesting — kept inside this
        // try so one malformed fact is routed to `skipped` rather than aborting
        // the whole batch (mirrors the other write routes' valDepthOk guard).
        const content = { type: f.type, val: f.val, lineage: anchorId, tags };
        const node: CbpNode =
          this.graph.getNodeByContent(content) ??
          this.graph.insertNode({ ...content, w: f.w, decay: "epoch", ttl: null });
        const resolved: ResolvedNode = { ...node, w: node.w ?? f.w, decay: node.decay ?? "epoch", ttl: node.ttl ?? null };
        const record = await projectNode(resolved, { tokenizer, embedder: this.embedder, deriver: this.deriver });
        // Upsert even on dedup-reuse so the memory record is present even if a prior ingest crashed mid-write.
        await this.memory.upsert(record);
        nodeIds.push(node.id);
        // Entity overlay (3B-G1): record entity membership OUTSIDE node content,
        // so identity (BLAKE3 over CONTENT_FIELDS incl. tags) is untouched. Idempotent,
        // so dedup-reuse re-adds harmlessly. Only string vals carry text entities.
        // BEST-EFFORT: the node is already committed, so an overlay failure must
        // not demote it into `skipped`.
        try {
          if (this.entityTagger && this.entityIndex && typeof f.val === "string") {
            this.entityIndex.add(node.id, this.entityTagger.tag(f.val));
          }
        } catch {
          /* overlay is best-effort; the node is already committed */
        }
      } catch (err) {
        // Capacity must surface to the caller (→ 507 at the REST boundary), never
        // be silently swallowed into `skipped` (that is silent data loss).
        if (err instanceof MaxNodesExceededError) throw err;
        skipped.push({ index: i, reason: err instanceof Error ? err.message : "ingest failed" });
      }
    }
    return { frameId, ingested: nodeIds.length, nodeIds, skipped };
  }

  /** Extract structured facts from a raw document via the Extractor, then ingest them. */
  async ingestDocument(
    frameId: string,
    document: string,
    extractor: Extractor,
    tokenizer: Tokenizer
  ): Promise<IngestResult> {
    const { facts, stats } = await extractor.extract(document);
    const result = await this.ingestFacts(frameId, facts, tokenizer);
    return { ...result, extract: stats };
  }
}
