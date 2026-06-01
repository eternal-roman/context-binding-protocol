// Types
export * from "./types/index.js";

// Wire format
export { canonicalize } from "./wire/index.js";

// Graph engine
export {
  computeFullHash,
  deriveId,
  deriveUniqueId,
  GraphStore,
  ConflictError,
  NodeNotFoundError,
  MaxNodesExceededError,
  PersistentGraphStore,
  PersistenceLoadError,
  createGraphStore,
} from "./graph/index.js";
export type {
  StoreConfig,
  PersistentGraphStoreOptions,
} from "./graph/index.js";

// Tokenizer
export {
  registerTokenizer,
  getTokenizer,
  listTokenizers,
  o200kTokenizer,
  lengthFallbackTokenizer,
} from "./tokenizer/index.js";
export type { Tokenizer } from "./tokenizer/index.js";

// CBQ parser
export { parseCbq, CbqParseError } from "./cbq/index.js";
export type {
  CbqQuery,
  CbqPredicate,
  WeightPredicate,
  TagPredicate,
  TypePredicate,
  RootPredicate,
  DepthPredicate,
  EdgesPredicate,
  IdPredicate,
} from "./cbq/index.js";

// Resolver
export {
  resolveFrame,
  resolveFrameWithQuery,
  evaluateCondition,
  ConditionEvalError,
  resolveInheritance,
  resolveAllInheritance,
} from "./resolver/index.js";
export type {
  FrameInput,
  ResolvedEdge,
  ResolvedFrame,
} from "./resolver/index.js";

// Decay Engine
export { DecayEngine } from "./decay/index.js";
export type { DecayEngineConfig, GcResult } from "./decay/index.js";

// Serializer
export {
  serializeFrame,
  estimateTokens,
  BudgetExceededError,
} from "./serializer/index.js";
export type {
  Tier,
  SerializeOptions,
  FullPayload,
  CondensedPayload,
  SignalPayload,
  SerializedPayload,
} from "./serializer/index.js";

// Frame Router
export { FrameRouter } from "./router/index.js";
export type { ConversationState, RouterConfig, TierReason } from "./router/index.js";

// WebSocket Streaming
export { StreamManager } from "./ws/index.js";
export type { StreamSubscription, StreamResult, MutationEvent } from "./ws/index.js";

// REST API
export { createCbpServer } from "./rest/index.js";
export type { CbpServerConfig, CbpServer } from "./rest/index.js";

// Embedded SDK
export { CbpClient } from "./sdk/index.js";
export type { CbpClientConfig } from "./sdk/index.js";

// Memory substrate (projection/index over the graph)
export * from "./memory/index.js";

// Recall seam — embed → govern → assemble-to-budget → LLM
export * from "./recall/index.js";

// Ingest — document/facts → graph + memory index
export * from "./ingest/index.js";
