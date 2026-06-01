import type { ResolvedNode } from "../types/node.js";
import type { Tokenizer } from "../tokenizer/tokenizer.js";
import type { Embedder } from "./embedder.js";
import type { FidelityDeriver } from "./fidelity.js";
import { DeterministicFidelityDeriver, costOf } from "./fidelity.js";
import type { MemoryRecord } from "./types.js";

export interface ProjectOptions {
  tokenizer: Tokenizer;
  deriver?: FidelityDeriver;   // defaults to DeterministicFidelityDeriver
  embedder?: Embedder;         // when present, embeds the Full fidelity
}

/**
 * Clamp a weight into the schema-mandated [0,1] range (NaN → 0). Defensive:
 * the graph insert path is not zod-validated, so an out-of-range `w` from an
 * upstream extractor (e.g. an LLM in the ingest demo) must not propagate into
 * a MemoryRecord and silently violate the record schema.
 */
function clampWeight(w: number): number {
  if (Number.isNaN(w)) return 0;
  return Math.min(1, Math.max(0, w));
}

/** Project a single resolved node into its memory-index record. */
export async function projectNode(node: ResolvedNode, opts: ProjectOptions): Promise<MemoryRecord> {
  const deriver = opts.deriver ?? new DeterministicFidelityDeriver();
  const fidelities = deriver.derive(node);
  const tokenCost = costOf(fidelities, opts.tokenizer);
  const embedding = opts.embedder ? await opts.embedder.embed(fidelities.full) : null;
  const embeddingModel = opts.embedder ? opts.embedder.modelId : null;
  return {
    id: node.id,
    nodeType: node.type,
    fidelities,
    tokenCost,
    embedding,
    embeddingModel,
    tags: node.tags,
    lineage: node.lineage,
    w: clampWeight(node.w),
  };
}

/**
 * Project a frame's resolved nodes into memory records. FRAME ANCHOR nodes
 * (type === "frame") are structural roots, not memories — excluded, matching
 * the serializer's treatment of frames as non-prunable anchors
 * (serializer.ts pruneToFit skips type === "frame").
 */
export async function projectFrameNodes(nodes: ResolvedNode[], opts: ProjectOptions): Promise<MemoryRecord[]> {
  const memories = nodes.filter((n) => n.type !== "frame");
  return Promise.all(memories.map((n) => projectNode(n, opts)));
}
