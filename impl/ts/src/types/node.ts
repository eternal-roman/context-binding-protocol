import { z } from "zod";

export const NodeType = z.enum([
  "entity",
  "state",
  "prior",
  "frame",
]);
export type NodeType = z.infer<typeof NodeType>;

export const DecayPolicy = z.enum(["epoch", "event", "none"]);
export type DecayPolicy = z.infer<typeof DecayPolicy>;

export const NodeId = z.string().regex(/^[0-9a-f]{8,64}$/);
export type NodeId = z.infer<typeof NodeId>;

export const CbpNode = z.object({
  id: NodeId,
  type: NodeType,
  val: z.unknown(),
  // Inheritable metadata (invariant #2): when omitted, the value is
  // inherited from the lineage chain at resolve time. These are NOT hashed
  // into the id (see CONTENT_FIELDS), so omitting them does not affect
  // content-addressable identity. The resolver fills them; consumers that
  // need a concrete node use ResolvedNode (below).
  w: z.number().min(0).max(1).optional(),
  decay: DecayPolicy.optional(),
  ttl: z.number().int().min(0).nullable().optional(),
  lineage: NodeId.nullable(),
  tags: z.array(z.string()),
  v: z.number().int().min(1),
  prev: NodeId.nullable(),
});
export type CbpNode = z.infer<typeof CbpNode>;

/**
 * A node after inheritance resolution: the inheritable metadata fields
 * (`w`, `decay`, `ttl`) are guaranteed concrete. This is the shape the
 * serializer and CBQ filters consume — never a partial stored node.
 */
export type ResolvedNode = Omit<CbpNode, "w" | "decay" | "ttl"> & {
  w: number;
  decay: DecayPolicy;
  ttl: number | null;
};

// Input schema for idempotent upsert (PUT /v1/node/:id) — `v` and `prev`
// are server-computed (insert: v=1, prev=null; update: v=existing.v+1,
// prev=existing.id). Client-supplied v/prev
// are ignored by the handler regardless; the input schema makes them *optional*
// in the input schema so clients may omit them entirely. Strict writes
// (POST /v1/node, PATCH /v1/node/:id, POST /v1/frame/:id/import) keep
// using CbpNode, which still requires v/prev — PUT is the only surface
// where the server owns the version chain.
export const CbpNodeInput = CbpNode.extend({
  v: z.number().int().min(1).optional(),
  prev: NodeId.nullable().optional(),
});
export type CbpNodeInput = z.infer<typeof CbpNodeInput>;

/** Fields hashed by BLAKE3 to derive the node id (G1). */
export const CONTENT_FIELDS = ["type", "val", "lineage", "tags"] as const;

/** Fields NOT hashed — operational metadata. */
export const METADATA_FIELDS = [
  "id",
  "w",
  "decay",
  "ttl",
  "v",
  "prev",
] as const;
