import { z } from "zod";
import { NodeType } from "../types/node.js";

export const Fidelity = z.enum(["full", "condensed", "signal"]);
export type Fidelity = z.infer<typeof Fidelity>;

const PerFidelity = <T extends z.ZodTypeAny>(
  v: T
): z.ZodObject<{ full: T; condensed: T; signal: T }> =>
  z.object({ full: v, condensed: v, signal: v });

/**
 * A MemoryRecord is a PROJECTION of a resolved CbpNode for the memory index —
 * NOT a second source of truth (graph/store.ts is canonical). Built by
 * `projectNode` (project.ts).
 *
 * Temporal fields (valid_at / invalid_at / created_at) are intentionally
 * ABSENT: CbpNode has none today; they arrive in Phase 5 (bi-temporal) and the
 * projection gains them then. A projection must not carry fields its source
 * cannot populate.
 */
export const MemoryRecord = z.object({
  id: z.string().regex(/^[0-9a-f]{8,64}$/),
  nodeType: NodeType,
  fidelities: PerFidelity(z.string()),
  tokenCost: PerFidelity(z.number().int().min(0)),
  embedding: z.array(z.number()).nullable(),
  embeddingModel: z.string().nullable(),
  tags: z.array(z.string()),
  lineage: z.string().nullable(),
  w: z.number().min(0).max(1),
});
export type MemoryRecord = z.infer<typeof MemoryRecord>;
