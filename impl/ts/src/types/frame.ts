import { z } from "zod";
import { DecayPolicy } from "./node.js";

export const InheritanceMode = z.enum(["prototypal", "override_only"]);
export type InheritanceMode = z.infer<typeof InheritanceMode>;

export const ConditionalEdgeEval = z.enum(["eager", "lazy"]);
export type ConditionalEdgeEval = z.infer<typeof ConditionalEdgeEval>;

export const RefreshPolicy = z
  .string()
  .regex(/^(on_demand|interval:[0-9]+|event:[a-z][a-z0-9_]*)$/);
export type RefreshPolicy = z.infer<typeof RefreshPolicy>;

export const FrameConfig = z.object({
  id: z.string().min(1).regex(/^[a-z][a-z0-9_]*$/),
  domain_tags: z.array(z.string()).default([]),
  root_weight: z.number().min(0).max(1),
  root_decay: DecayPolicy,
  refresh_policy: RefreshPolicy.default("on_demand"),
  max_token_budget: z.number().int().min(1),
  inheritance_mode: InheritanceMode,
  conditional_edge_eval: ConditionalEdgeEval.default("eager"),
  tokenizer: z.string().default("o200k_base"),
  acl_tags: z.array(z.string()).default([]),
});
export type FrameConfig = z.infer<typeof FrameConfig>;
