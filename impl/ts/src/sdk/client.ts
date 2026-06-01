/**
 * Embedded SDK — in-process CBP client for autonomous agents.
 *
 * Mode 4 from cbp-architecture.html §VI: "The agent reads and writes
 * to the graph — recording its own outputs as prior nodes, updating
 * state based on actions taken. The graph becomes the agent's
 * persistent working memory."
 *
 * This client runs in-process (no HTTP). It wraps the GraphStore,
 * Resolver, Serializer, and FrameRouter directly.
 *
 * @see cbp-architecture.html Section VI — Mode 4: Embedded SDK
 */

import { GraphStore } from "../graph/store.js";
import { createGraphStore } from "../graph/factory.js";
import { PersistentGraphStore } from "../graph/persistence.js";
import { resolveFrame, resolveFrameWithQuery } from "../resolver/resolver.js";
import { estimateTokens } from "../serializer/serializer.js";
import { FrameRouter } from "../router/router.js";
import { DecayEngine } from "../decay/engine.js";
import type { CbpNode } from "../types/node.js";
import type { CbpEdge } from "../types/edge.js";
import type { FrameConfig } from "../types/frame.js";
import type { ResolvedFrame } from "../resolver/resolver.js";
import type { Tier, SerializedPayload } from "../serializer/serializer.js";
import type { PersistenceConfig, ServerConfig } from "../types/config.js";
import { InMemoryMemoryStore, type MemoryStore } from "../memory/store.js";
import { HashingEmbedder, type Embedder } from "../memory/embedder.js";
import { MemoryIngestor } from "../ingest/ingest.js";
import { LlmExtractor } from "../ingest/extract.js";
import type { Fact } from "../ingest/types.js";
import { EchoLlmClient, OpenAiCompatLlmClient, type LlmClient } from "../recall/llm.js";
import { RecallPipeline } from "../recall/pipeline.js";
import type { AssembledContext } from "../recall/types.js";
import { getTokenizer, type Tokenizer } from "../tokenizer/tokenizer.js";
import { MemoryConfig } from "../types/config.js";
// Side-effect import: registers built-in tokenizers
import "../tokenizer/index.js";

export interface CbpClientConfig {
  frameConfig: FrameConfig;
  serverConfig?: Partial<ServerConfig>;
  persistence?: PersistenceConfig;
  writeAccess?: boolean;
  conversationId?: string;
  /**
   * Invoked when a background persistence flush fails (filesystem driver).
   * Defaults to console.error.
   */
  onPersistenceError?: (err: Error) => void;
  /** Optional memory subsystem config (embedder dim, default k, recall budget, llm). Defaults are dep-free + key-free. */
  memory?: Partial<MemoryConfig>;
  /**
   * Inject a constructed LlmClient (e.g. a custom adapter). Takes precedence over `memory.llm` config.
   * Defaults to the config-derived client (EchoLlmClient when unconfigured).
   */
  llmClient?: LlmClient;
}

/**
 * In-process CBP client for autonomous agents.
 *
 * Provides a clean API for:
 * - Resolving frames (with optional CBQ queries)
 * - Serializing at any tier (with token budget enforcement)
 * - Upserting nodes (for agents that write to the graph)
 * - Recording priors (agent outputs as context for future turns)
 */
export class CbpClient {
  readonly store: GraphStore;
  readonly router: FrameRouter;
  readonly decay: DecayEngine;
  readonly frameConfig: FrameConfig;
  /**
   * The frame's memory index. Exposed read-only for inspection/tests. Do NOT
   * write to it directly (e.g. memoryStore.upsert) — that bypasses the frame
   * partition tag and write-access gate; use ingest()/ingestDocument() instead.
   */
  readonly memoryStore: MemoryStore;

  private readonly conversationId: string;
  private readonly writeAccess: boolean;
  private frameVersion = 1;

  private readonly embedder: Embedder;
  private readonly tokenizer: Tokenizer;
  private readonly ingestor: MemoryIngestor;
  private readonly pipeline: RecallPipeline;
  private readonly llm: LlmClient;
  private readonly recallBudget: number;
  private readonly defaultK: number;

  constructor(config: CbpClientConfig) {
    this.frameConfig = config.frameConfig;
    this.writeAccess = config.writeAccess ?? false;
    this.conversationId = config.conversationId ?? `sdk-${Date.now()}`;

    this.store = createGraphStore(
      {
        maxNodesPerFrame: config.serverConfig?.max_nodes_per_frame ?? 500,
        maxDepth: config.serverConfig?.max_depth ?? 8,
      },
      config.persistence,
      { onFlushError: config.onPersistenceError }
    );

    this.router = new FrameRouter({
      condensedThreshold: config.serverConfig?.compression?.condensed_threshold ?? 0.3,
      signalMinTurns: config.serverConfig?.compression?.signal_min_turns ?? 3,
    });

    this.decay = new DecayEngine({
      epochIntervalSeconds: config.serverConfig?.epoch_interval_seconds ?? 3600,
      decayFactor: config.serverConfig?.decay_factor ?? 0.85,
      gcThreshold: config.serverConfig?.gc_policy?.threshold ?? 0.1,
    });

    const mem = MemoryConfig.parse(config.memory ?? {});
    this.embedder = new HashingEmbedder(mem.dim);
    this.memoryStore = new InMemoryMemoryStore();
    this.tokenizer = getTokenizer(this.frameConfig.tokenizer);
    this.recallBudget = mem.recall_budget;
    this.defaultK = mem.default_k;
    this.llm =
      config.llmClient ??
      (mem.llm.provider === "openai_compat" && mem.llm.base_url && mem.llm.model
        ? new OpenAiCompatLlmClient({ baseUrl: mem.llm.base_url, model: mem.llm.model, apiKeyEnv: mem.llm.api_key_env ?? "CBP_LLM_API_KEY" })
        : new EchoLlmClient());
    this.ingestor = new MemoryIngestor({ graph: this.store, memory: this.memoryStore, embedder: this.embedder });
    this.pipeline = new RecallPipeline({ embedder: this.embedder, memory: this.memoryStore, llm: this.llm, defaultK: this.defaultK });
  }

  /** Load nodes into the store (for initialization). */
  loadNodes(nodes: CbpNode[]): void {
    for (const node of nodes) {
      this.store.loadNode(node);
    }
  }

  /** Load edges into the store (for initialization). */
  loadEdges(edges: CbpEdge[]): void {
    for (const edge of edges) {
      this.store.loadEdge(edge);
    }
  }

  /**
   * Resolve the frame: apply inheritance, evaluate conditionals.
   * Optionally filter with a CBQ query.
   */
  resolve(cbq?: string): ResolvedFrame {
    const input = {
      frame: this.frameConfig,
      nodes: this.store.getAllNodes(),
      edges: this.store.getAllEdges(),
    };

    if (cbq) {
      return resolveFrameWithQuery(input, cbq) as ResolvedFrame;
    }
    return resolveFrame(input);
  }

  /**
   * Serialize the frame at a given tier (or auto).
   * Routes through the FrameRouter for tier negotiation.
   */
  serialize(
    tier: Tier | "auto" = "auto"
  ): { payload: SerializedPayload; wire: string; tokens: number; actualTier: Tier } {
    const resolved = this.resolve();
    return this.router.deliver(
      this.conversationId,
      resolved,
      this.frameVersion,
      tier
    );
  }

  /** Get token estimates at all three tiers. */
  budget(): { full: number; condensed: number; signal: number } {
    const resolved = this.resolve();
    return estimateTokens(resolved, this.frameVersion);
  }

  /**
   * Upsert a node (requires writeAccess).
   * For agents recording their own outputs as priors or updating state.
   */
  upsert(
    nodeId: string,
    update: Partial<Omit<CbpNode, "id" | "v" | "prev">>,
    expectedV: number
  ): CbpNode {
    if (!this.writeAccess) {
      throw new Error("CbpClient: write access not enabled. Set writeAccess: true in config.");
    }
    const result = this.store.upsertNode(nodeId, update, expectedV);
    this.frameVersion++;
    return result;
  }

  /**
   * Record a prior — convenience method for agents to record
   * their own outputs, decisions, or observations as prior nodes.
   *
   * This is the primary write operation for autonomous agents:
   * the agent takes an action, records the result as a prior that
   * qualifies future decisions.
   */
  recordPrior(input: {
    val: unknown;
    parentId: string;
    tags?: string[];
    decay?: "epoch" | "event" | "none";
    ttl?: number | null;
    w?: number;
  }): CbpNode {
    if (!this.writeAccess) {
      throw new Error("CbpClient: write access not enabled. Set writeAccess: true in config.");
    }

    const node = this.store.insertNode({
      type: "prior",
      val: input.val,
      w: input.w ?? 0.7,
      decay: input.decay ?? "event",
      ttl: input.ttl ?? null,
      lineage: input.parentId,
      tags: input.tags ?? [],
    });

    this.frameVersion++;
    return node;
  }

  /** Manually trigger a decay sweep. */
  sweep(): ReturnType<DecayEngine["sweep"]> {
    return this.decay.sweep(this.store);
  }

  /** Trigger an event-based decay reset. */
  triggerEvent(eventName: string, nodeIds: string[], resetWeight?: number): number {
    return this.decay.triggerEvent(this.store, eventName, nodeIds, resetWeight);
  }

  private scopeTags(): string[] { return [`frame:${this.frameConfig.id}`]; }
  private effectiveBudget(b?: number): number {
    return Math.min(b ?? this.recallBudget, this.frameConfig.max_token_budget);
  }

  /** Ingest already-structured facts into this client's frame (graph + memory index). */
  async ingest(facts: Fact[]): ReturnType<MemoryIngestor["ingestFacts"]> {
    if (!this.writeAccess) {
      throw new Error("CbpClient: write access not enabled. Set writeAccess: true in config.");
    }
    return this.ingestor.ingestFacts(this.frameConfig.id, facts, this.tokenizer);
  }

  /** Extract facts from a raw document (via the configured LlmClient) and ingest them. */
  async ingestDocument(doc: string, opts?: { maxChars?: number; maxChunks?: number }): ReturnType<MemoryIngestor["ingestDocument"]> {
    if (!this.writeAccess) {
      throw new Error("CbpClient: write access not enabled. Set writeAccess: true in config.");
    }
    return this.ingestor.ingestDocument(this.frameConfig.id, doc, new LlmExtractor(this.llm, opts ?? {}), this.tokenizer);
  }

  /** Governed, ranked, budget-assembled recall within this client's frame. */
  async recall(query: string, opts?: { k?: number; budget?: number; filterTags?: string[]; minScore?: number }): Promise<AssembledContext> {
    return this.pipeline.recall(query, {
      scopeTags: this.scopeTags(), budget: this.effectiveBudget(opts?.budget), tokenizer: this.tokenizer,
      k: opts?.k, filterTags: opts?.filterTags, minScore: opts?.minScore,
    });
  }

  /** Recall + LlmClient: returns { answer, context }. With the default EchoLlmClient the answer is the assembled block. */
  async ask(query: string, opts?: { k?: number; budget?: number; filterTags?: string[]; minScore?: number; system?: string }): ReturnType<RecallPipeline["ask"]> {
    return this.pipeline.ask(query, {
      scopeTags: this.scopeTags(), budget: this.effectiveBudget(opts?.budget), tokenizer: this.tokenizer,
      k: opts?.k, filterTags: opts?.filterTags, minScore: opts?.minScore, system: opts?.system,
    });
  }

  /**
   * Drain pending persistence writes and stop scheduling new ones.
   * No-op when the memory driver is in use.
   */
  async close(): Promise<void> {
    if (this.store instanceof PersistentGraphStore) {
      await this.store.close();
    }
  }
}
