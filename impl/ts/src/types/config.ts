import { z } from "zod";
import { DecayPolicy } from "./node.js";

export const GcPolicy = z.object({
  strategy: z.enum(["prune_below_weight"]),
  threshold: z.number().min(0).max(1).default(0.1),
});
export type GcPolicy = z.infer<typeof GcPolicy>;

export const CompressionConfig = z.object({
  condensed_threshold: z.number().min(0).max(1).default(0.3),
  signal_min_turns: z.number().int().min(0).default(3),
});
export type CompressionConfig = z.infer<typeof CompressionConfig>;

export const PersistenceConfig = z.object({
  driver: z.enum(["memory", "filesystem"]).default("memory"),
  path: z.string().optional(),
});
export type PersistenceConfig = z.infer<typeof PersistenceConfig>;

export const LlmConfig = z.object({
  provider: z.enum(["echo", "openai_compat"]).default("echo"),
  base_url: z.string().url().optional(),   // openai_compat only
  model: z.string().optional(),
  api_key_env: z.string().optional(),       // env var NAME holding the key — NEVER the key itself
});
export type LlmConfig = z.infer<typeof LlmConfig>;

export const MemoryConfig = z.object({
  embedder: z.enum(["hashing"]).default("hashing"),  // real embedders join in a later phase
  dim: z.number().int().min(1).default(256),
  default_k: z.number().int().min(1).default(50),
  recall_budget: z.number().int().min(1).default(2000),
  llm: LlmConfig.default({}),
});
export type MemoryConfig = z.infer<typeof MemoryConfig>;

export const ServerConfig = z.object({
  // NOTE: despite the name, this currently bounds the GLOBAL live working set
  // (total live nodes across all frames in one store), not a per-frame quota —
  // see GraphStore.wouldExceedLiveCap / insertNode, which throw with frame id
  // "(global)". True per-frame / per-tenant quotas are a tenancy-layer feature
  // (operability ring), not yet implemented. For single-frame deployments the
  // two are identical.
  max_nodes_per_frame: z.number().int().min(1).default(500),
  max_depth: z.number().int().min(1).default(8),
  max_conversations: z.number().int().min(1).default(10000),
  default_decay: DecayPolicy.default("epoch"),
  epoch_interval_seconds: z.number().int().min(1).default(3600),
  decay_factor: z.number().gt(0).lte(1).default(0.85),
  gc_policy: GcPolicy.default({ strategy: "prune_below_weight", threshold: 0.1 }),
  edge_vocabulary: z.enum(["standard_8", "extended_12"]).default("standard_8"),
  compression: CompressionConfig.default({}),
  persistence: PersistenceConfig.default({ driver: "memory" }),
  // Optional — when omitted, consumers apply MemoryConfig.parse({}) defaults.
  // OPTIONAL (not .default) so existing ServerConfig object literals that omit
  // it remain type-valid.
  memory: MemoryConfig.optional(),
});
export type ServerConfig = z.infer<typeof ServerConfig>;

export const TierPreference = z.enum(["full", "condensed", "signal", "auto"]);
export type TierPreference = z.infer<typeof TierPreference>;

export const MultiFrameStrategy = z.enum([
  "merge",
  "priority_stack",
  "isolate",
]);
export type MultiFrameStrategy = z.infer<typeof MultiFrameStrategy>;

export const StaleFramePolicy = z.enum(["warn", "refresh", "use_cached"]);
export type StaleFramePolicy = z.infer<typeof StaleFramePolicy>;

export const ClientConfig = z.object({
  preferred_tier: TierPreference.default("auto"),
  context_window_budget: z.number().int().min(1).optional(),
  multi_frame_strategy: MultiFrameStrategy.default("isolate"),
  stale_frame_policy: StaleFramePolicy.default("refresh"),
  write_access: z.boolean().default(false),
});
export type ClientConfig = z.infer<typeof ClientConfig>;
