import { z } from "zod";
import { DecayPolicy, NodeId } from "./node.js";

export const EdgeRelation = z.enum([
  "causes",
  "correlates",
  "contradicts",
  "qualifies",
  "supersedes",
  "requires",
  "inhibits",
  "amplifies",
]);
export type EdgeRelation = z.infer<typeof EdgeRelation>;

export const ComparisonOp = z.enum([
  "eq",
  "ne",
  "lt",
  "lte",
  "gt",
  "gte",
  "in",
  "contains",
  "matches",
  "exists",
]);
export type ComparisonOp = z.infer<typeof ComparisonOp>;

export const ConditionLeaf: z.ZodType = z.object({
  field: z.string().regex(/^[a-z]+:[A-Za-z0-9_]+(\.[A-Za-z_][A-Za-z0-9_]*)*$/),
  op: ComparisonOp,
  value: z.unknown().optional(),
});
export type ConditionLeaf = z.infer<typeof ConditionLeaf>;

// Recursive condition type — must use lazy() for self-reference
export type Condition =
  | "always"
  | ConditionLeaf
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition };

export const Condition: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.literal("always"),
    ConditionLeaf,
    z.object({ all: z.array(Condition).min(1) }),
    z.object({ any: z.array(Condition).min(1) }),
    z.object({ not: Condition }),
  ])
);

export const CbpEdge = z.object({
  id: NodeId,
  src: NodeId,
  tgt: NodeId,
  rel: EdgeRelation,
  strength: z.number().min(-1).max(1).default(1),
  conditional: Condition,
  w: z.number().min(0).max(1).default(1),
  decay: DecayPolicy.default("none"),
  ttl: z.number().int().min(0).nullable().optional(),
  v: z.number().int().min(1),
  prev: NodeId.nullable().optional(),
});
export type CbpEdge = z.infer<typeof CbpEdge>;

// Input schema for idempotent edge upsert (PUT /v1/edge/:id) — `v` is
// server-computed (insert: v=1; update: v=existing.v+1). Mirrors
// CbpNodeInput from ./node.ts. `prev` was already optional on CbpEdge
// since v0.8.0; v0.8.1 makes `v` optional on the PUT input path as well
// so clients may omit both version fields entirely. POST /v1/edge keeps
// using CbpEdge (strict insert — v still required).
export const CbpEdgeInput = CbpEdge.extend({
  v: z.number().int().min(1).optional(),
});
export type CbpEdgeInput = z.infer<typeof CbpEdgeInput>;
