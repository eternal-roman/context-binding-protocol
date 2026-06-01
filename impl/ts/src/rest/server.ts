/**
 * CBP REST API server — all endpoints from cbp-architecture.html §IX.
 *
 * Surfaces: /v1/frames, /v1/frame/:id, /v1/frame/:id/budget,
 *           /v1/frame/:id/eval, /v1/frame/:id/export,
 *           /v1/frame/:id/import, /v1/node, /v1/node/:id,
 *           /v1/edge, /v1/edge/:id, /healthz
 *
 * Authentication: Bearer token (G8 v0.x). Per-frame ACL tags.
 * Concurrency: 409 Conflict on version mismatch (G7).
 *
 * @see cbp-architecture.html Section IX — Interface Contract
 * @see spec/schemas/config.schema.json — server/client config
 */

/**
 * Read at module init from impl/ts/package.json. Resolves identically in
 * both the source layout (src/rest/server.ts → ../../package.json) and the
 * built layout (dist/rest/server.js → ../../package.json). Surfaced via
 * GET /healthz so probes never drift from the published version.
 */
const CBP_IMPL_VERSION: string = ((): string => {
  const pkgPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../package.json"
  );
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
    version: string;
  };
  return pkg.version;
})();

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import type { FastifyInstance, FastifyRequest } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { GraphStore, ConflictError, NodeNotFoundError, MaxNodesExceededError } from "../graph/store.js";
import { createGraphStore } from "../graph/factory.js";
import { PersistentGraphStore } from "../graph/persistence.js";
import { resolveFrame, resolveFrameWithQuery } from "../resolver/resolver.js";
import { CbqParseError } from "../cbq/parser.js";
import { FrameRouter } from "../router/router.js";
import { DecayEngine } from "../decay/engine.js";
import { estimateTokens, BudgetExceededError } from "../serializer/serializer.js";
import { canonicalize, CanonicalizeError } from "../wire/canonical.js";
import { StreamManager } from "../ws/stream.js";
import type { MutationEvent } from "../ws/stream.js";
import { CbpNode, CbpNodeInput } from "../types/node.js";
import { CbpEdge, CbpEdgeInput } from "../types/edge.js";
import { FrameConfig } from "../types/frame.js";
import type { ServerConfig } from "../types/config.js";
import { TierPreference, MemoryConfig } from "../types/config.js";
// Side-effect import: registers built-in tokenizers (o200k_base, length_fallback)
import "../tokenizer/index.js";
import { HashingEmbedder } from "../memory/embedder.js";
import { InMemoryMemoryStore } from "../memory/store.js";
import type { MemoryStore } from "../memory/store.js";
import { MemoryIngestor } from "../ingest/ingest.js";
import { LlmExtractor } from "../ingest/extract.js";
import { RecallPipeline } from "../recall/pipeline.js";
import { EchoLlmClient, OpenAiCompatLlmClient } from "../recall/llm.js";
import type { LlmClient } from "../recall/llm.js";
import { getTokenizer } from "../tokenizer/tokenizer.js";

export interface CbpServerConfig {
  port: number;
  host: string;
  serverConfig: ServerConfig;
  /** Bearer tokens that are authorized to access the API. Map of token → label. */
  tokens: Map<string, string>;
  /** Frame configurations indexed by frame id. */
  frames: Map<string, FrameConfig>;
  logLevel?: string;
  /**
   * Invoked when a background persistence flush fails (filesystem driver).
   * Use this to wire up alerting / degraded-state handling in a deployment.
   * Defaults to console.error.
   */
  onPersistenceError?: (err: Error) => void;
}

export interface CbpServer {
  app: FastifyInstance;
  store: GraphStore;
  router: FrameRouter;
  decay: DecayEngine;
  streamManager: StreamManager;
  memoryStore: MemoryStore;
  start(): Promise<string>;
  stop(): Promise<void>;
}

export function createCbpServer(config: CbpServerConfig): CbpServer {
  const app = Fastify({
    logger: {
      level: config.logLevel ?? "info",
    },
  });

  // Accept empty application/json bodies (v0.5). Some CBP endpoints such
  // as POST /v1/frame/:id/eval don't require a body; the default Fastify
  // parser rejects empty bodies with 400 which leaked complexity into
  // every consumer. We parse empty strings as an empty object and let
  // Zod-level validation catch real schema violations downstream.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_request, body, done) => {
      const text = typeof body === "string" ? body : body.toString();
      if (text.trim() === "") {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(text));
      } catch (err) {
        (err as { statusCode?: number }).statusCode = 400;
        done(err as Error, undefined);
      }
    }
  );

  const store = createGraphStore(
    {
      maxNodesPerFrame: config.serverConfig.max_nodes_per_frame,
      maxDepth: config.serverConfig.max_depth,
    },
    config.serverConfig.persistence,
    { onFlushError: config.onPersistenceError }
  );

  const router = new FrameRouter({
    condensedThreshold: config.serverConfig.compression.condensed_threshold,
    signalMinTurns: config.serverConfig.compression.signal_min_turns,
    maxConversations: config.serverConfig.max_conversations,
  });

  const decay = DecayEngine.fromServerConfig(config.serverConfig);

  const streamManager = new StreamManager();

  // Memory subsystem (recall seam). Defaults are dep-free + key-free; memory
  // config is optional on ServerConfig, so fall back to MemoryConfig defaults.
  const mem = MemoryConfig.parse(config.serverConfig.memory ?? {});
  const embedder = new HashingEmbedder(mem.dim);
  const memoryStore: MemoryStore = new InMemoryMemoryStore();
  const ingestor = new MemoryIngestor({ graph: store, memory: memoryStore, embedder });
  const serverLlm: LlmClient =
    mem.llm.provider === "openai_compat" && mem.llm.base_url && mem.llm.model
      ? new OpenAiCompatLlmClient({ baseUrl: mem.llm.base_url, model: mem.llm.model, apiKeyEnv: mem.llm.api_key_env ?? "CBP_LLM_API_KEY" })
      : new EchoLlmClient();
  const pipeline = new RecallPipeline({ embedder, memory: memoryStore, llm: serverLlm, defaultK: mem.default_k });

  /**
   * Helper invoked from every mutation route to push a lightweight
   * event to any active WS subscribers of the mutation's frame. The
   * frame is resolved from the node's lineage (same walk isInFrame
   * uses); if the node isn't in any configured frame, the event is
   * dropped silently — there are no legitimate subscribers for it.
   */
  const emitMutation = (event: MutationEvent): void => {
    streamManager.notifyEvent(event);
  };

  // --- Authentication hook ---
  // /healthz is intentionally unauthenticated (v0.5) so that load balancers
  // and supervisors can probe liveness without managing a bearer token.
  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?", 1)[0];
    if (path === "/healthz") return;

    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return reply.code(401).send({ error: "Missing or invalid Authorization header" });
    }
    const token = authHeader.slice(7);
    if (!config.tokens.has(token)) {
      return reply.code(403).send({ error: "Invalid bearer token" });
    }
    // Attach token label for ACL checking
    (request as unknown as Record<string, unknown>)["cbpTokenLabel"] = config.tokens.get(token);
  });

  // --- GET /healthz (unauthenticated) ---
  app.get("/healthz", async () => ({
    status: "ok",
    uptime_s: Math.floor(process.uptime()),
    version: CBP_IMPL_VERSION,
    frames: config.frames.size,
  }));

  // --- WebSocket streaming (Mode 3, v0.7) ---
  // Register the plugin and the /v1/stream/:frame_id route. Authentication
  // piggybacks on the existing bearer-token onRequest hook: the WS upgrade
  // is an HTTP GET with an Authorization header, so 401/403 surface before
  // the socket is promoted. Subscribers receive a JSON envelope per
  // MutationEvent when the underlying frame changes.
  app.register(fastifyWebsocket);
  app.register(async (scope) => {
    scope.get<{ Params: { frame_id: string } }>(
      "/v1/stream/:frame_id",
      { websocket: true },
      (socket, request: FastifyRequest<{ Params: { frame_id: string } }>) => {
        const frameId = request.params.frame_id;
        const frameConfig = config.frames.get(frameId);
        if (!frameConfig) {
          socket.close(1008, `Frame not found: ${frameId}`);
          return;
        }
        if (!checkAcl(frameConfig, request)) {
          socket.close(1008, "Insufficient ACL for this frame");
          return;
        }

        const conversationId =
          (request.headers["x-cbp-conversation"] as string | undefined) ??
          `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        const unsubscribe = streamManager.subscribe({
          conversationId,
          frameId,
          preferredTier: "auto",
          send: (data: string): void => {
            if (socket.readyState === socket.OPEN) socket.send(data);
          },
          close: (): void => {
            socket.close();
          },
        });

        socket.on("close", () => unsubscribe());
        socket.on("error", () => unsubscribe());
      }
    );
  });

  // --- GET /v1/frames ---
  app.get("/v1/frames", async () => {
    const frameIds = [...config.frames.keys()];
    return { frames: frameIds };
  });

  // --- GET /v1/frame/:id ---
  app.get<{ Params: { id: string }; Querystring: { tier?: string; cbq?: string } }>(
    "/v1/frame/:id",
    async (request, reply) => {
      const frameConfig = config.frames.get(request.params.id);
      if (!frameConfig) {
        return reply.code(404).send({ error: `Frame not found: ${request.params.id}` });
      }

      // ACL check
      if (!checkAcl(frameConfig, request)) {
        return reply.code(403).send({ error: "Insufficient ACL for this frame" });
      }

      // Validate the requested tier at the boundary. An unknown value must be a
      // 400 (client error), not an uncaught TypeError downstream in the tier
      // cascade (which would surface as a 500). Mirrors the CBQ-parse 400 path.
      const tierParsed = TierPreference.safeParse(request.query.tier ?? "auto");
      if (!tierParsed.success) {
        return reply.code(400).send({
          error: "Invalid tier",
          details: 'tier must be one of "full", "condensed", "signal", or "auto"',
        });
      }
      const tier = tierParsed.data;
      const conversationId = request.headers["x-cbp-conversation"] as string ?? "default";

      const allNodes = store.getAllNodes().filter((n) => isInFrame(n, frameConfig.id, store));
      const allEdges = store.getAllEdges().filter((e) => {
        const src = store.getNode(e.src);
        return src && isInFrame(src, frameConfig.id, store);
      });

      const frameInput = { frame: frameConfig, nodes: allNodes, edges: allEdges };
      let resolved;
      try {
        resolved = request.query.cbq
          ? resolveFrameWithQuery(frameInput, request.query.cbq)
          : resolveFrame(frameInput);
      } catch (err) {
        if (err instanceof CbqParseError) {
          return reply.code(400).send({
            error: "Invalid CBQ query",
            details: err.message,
          });
        }
        throw err;
      }
      const frameVersion = computeFrameVersion(allNodes);

      try {
        const result = router.deliver(conversationId, resolved, frameVersion, tier);
        reply.header("content-type", `application/cbp+json; tier=${result.actualTier}`);
        reply.header("x-cbp-tokens", result.tokens.toString());
        reply.header("x-cbp-tier-reason", result.reason);
        if (request.query.cbq) {
          reply.header("x-cbp-cbq-applied", "true");
        }
        return reply.send(result.wire);
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          const estimates = estimateTokens(resolved, frameVersion);
          return reply.code(413).send({
            reason: "budget_exceeded",
            estimates,
            max_token_budget: frameConfig.max_token_budget,
            suggestion:
              "raise max_token_budget or apply a CBQ filter to reduce the frame",
          });
        }
        throw err;
      }
    }
  );

  // --- GET /v1/frame/:id/budget ---
  app.get<{ Params: { id: string } }>(
    "/v1/frame/:id/budget",
    async (request, reply) => {
      const frameConfig = config.frames.get(request.params.id);
      if (!frameConfig) {
        return reply.code(404).send({ error: `Frame not found: ${request.params.id}` });
      }

      // ACL check (S1): budget estimates expose token-count and structural
      // information about the frame, so this route must enforce the same
      // ACL as every other frame-scoped endpoint.
      if (!checkAcl(frameConfig, request)) {
        return reply.code(403).send({ error: "Insufficient ACL for this frame" });
      }

      const allNodes = store.getAllNodes().filter((n) => isInFrame(n, frameConfig.id, store));
      const allEdges = store.getAllEdges().filter((e) => {
        const src = store.getNode(e.src);
        return src && isInFrame(src, frameConfig.id, store);
      });

      const resolved = resolveFrame({ frame: frameConfig, nodes: allNodes, edges: allEdges });
      const frameVersion = computeFrameVersion(allNodes);
      const estimates = estimateTokens(resolved, frameVersion);

      return {
        frame_id: frameConfig.id,
        max_token_budget: frameConfig.max_token_budget,
        estimates,
      };
    }
  );

  // --- POST /v1/node (v0.6) ---
  // Strict insert: 409 if the id already exists (use PATCH /v1/node/:id for
  // updates). Rejects nodes whose lineage chain does not terminate at any
  // configured frame (422) to prevent silent orphans and ACL bypass via
  // cross-frame lineage claims. ACL is enforced against the resolved
  // containing frame.
  app.post<{ Body: unknown }>("/v1/node", async (request, reply) => {
    const parsed = CbpNode.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid node", details: parsed.error.issues });
    }
    const node = parsed.data;

    if (!valDepthOk(node.val)) {
      return reply.code(400).send({
        error: "Node val nests beyond the canonical-form depth limit",
      });
    }

    const collision = store.getNode(node.id);
    if (collision) {
      return reply.code(409).send({
        error: `Node with id "${node.id}" already exists`,
        current_v: collision.v,
        hint: "use PATCH /v1/node/:id for updates",
      });
    }

    // Build a combined lookup that includes the proposed new node so that
    // a POST of a frame-type node (or of a node whose lineage references
    // this new node — not possible in single-POST, but safe either way)
    // resolves correctly.
    const combinedLookup = (id: string): CbpNode | undefined =>
      id === node.id ? node : store.getNode(id);
    let containingFrame: FrameConfig | undefined;
    for (const frame of config.frames.values()) {
      if (isInFrameVia(node, frame.id, combinedLookup)) {
        containingFrame = frame;
        break;
      }
    }
    if (!containingFrame) {
      return reply.code(422).send({
        error: "Node lineage does not terminate at any configured frame",
        hint: "ensure the node's lineage chain reaches a frame root that matches a configured frame id",
      });
    }
    if (!checkAcl(containingFrame, request)) {
      return reply.code(403).send({ error: "Insufficient ACL for this node's frame" });
    }
    // Capacity (S4a): POST is always a strict insert (collision → 409 above),
    // so it adds exactly one live node.
    if (store.wouldExceedLiveCap(1)) {
      return reply.code(507).send({
        error: "Store at capacity (max_nodes_per_frame)",
        max_nodes_per_frame: config.serverConfig.max_nodes_per_frame,
      });
    }

    store.loadNode(node);
    emitMutation({
      event: "node_upserted",
      frame_id: containingFrame.id,
      node_id: node.id,
      v: node.v,
    });
    return reply.code(201).send(node);
  });

  // --- PATCH /v1/node/:id (v0.6) ---
  // Optimistic-concurrency update (G7). Body: { expectedV: number, update: {...} }.
  // Returns 409 with the current version on mismatch, 404 if the node is
  // missing, 403 if the caller lacks ACL for the node's containing frame.
  app.patch<{ Params: { id: string }; Body: unknown }>(
    "/v1/node/:id",
    async (request, reply) => {
      const existing = store.getNode(request.params.id);
      if (!existing) {
        return reply.code(404).send({ error: `Node not found: ${request.params.id}` });
      }

      const body = request.body as
        | { expectedV?: unknown; update?: unknown }
        | null;
      if (
        !body ||
        typeof body !== "object" ||
        typeof body.expectedV !== "number" ||
        !body.update ||
        typeof body.update !== "object"
      ) {
        return reply.code(400).send({
          error: "PATCH body must be { expectedV: number, update: object }",
        });
      }

      const frame = findFrameForNode(existing, config.frames, store);
      if (!frame) {
        return reply
          .code(404)
          .send({ error: "Node is not in any configured frame" });
      }
      if (!checkAcl(frame, request)) {
        return reply.code(403).send({ error: "Insufficient ACL for this node's frame" });
      }

      try {
        const updated = store.upsertNode(
          request.params.id,
          body.update as Parameters<GraphStore["upsertNode"]>[1],
          body.expectedV
        );
        emitMutation({
          event: "node_upserted",
          frame_id: frame.id,
          node_id: updated.id,
          v: updated.v,
        });
        return reply.send(updated);
      } catch (err) {
        if (err instanceof ConflictError) {
          return reply.code(409).send({
            error: "Version conflict",
            expected_v: err.expectedV,
            current_v: err.actualV,
          });
        }
        if (err instanceof NodeNotFoundError) {
          return reply.code(404).send({ error: err.message });
        }
        throw err;
      }
    }
  );

  // --- GET /v1/node/:id (v0.5) ---
  app.get<{ Params: { id: string } }>("/v1/node/:id", async (request, reply) => {
    const node = store.getNode(request.params.id);
    if (!node) {
      return reply.code(404).send({ error: `Node not found: ${request.params.id}` });
    }
    const frame = findFrameForNode(node, config.frames, store);
    if (!frame) {
      return reply
        .code(404)
        .send({ error: `Node not in any configured frame: ${request.params.id}` });
    }
    if (!checkAcl(frame, request)) {
      return reply.code(403).send({ error: "Insufficient ACL for this node's frame" });
    }
    return reply.send(node);
  });

  // --- PUT /v1/node/:id (v0.8) ---
  // Idempotent last-writer-wins upsert. If no node with the URL id exists,
  // inserts with v=1 (201 Created). If a node exists, upserts with
  // v=existing.v+1 and prev=existing.id (200 OK). Server always computes v
  // and prev; client-supplied values are ignored. v0.8.1 relaxes the input
  // schema (CbpNodeInput) so clients may omit v and prev entirely — the
  // contract ("client-supplied v/prev are ignored") is enforced
  // here whether the fields are present or absent. Enforces the same
  // frame-root containment + ACL invariants as POST /v1/node.
  //
  // Use this for "memory upsert" patterns where client-derived ids carry
  // the deterministic content-addressable semantics (e.g. hash-of-label).
  // Use POST /v1/node when id collisions must fail loudly; use PATCH for
  // optimistic-concurrency updates with expectedV.
  app.put<{ Params: { id: string }; Body: unknown }>(
    "/v1/node/:id",
    async (request, reply) => {
      const parsed = CbpNodeInput.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "Invalid node", details: parsed.error.issues });
      }
      const body = parsed.data;
      if (body.id !== request.params.id) {
        return reply.code(400).send({
          error: `body.id "${body.id}" does not match URL id "${request.params.id}"`,
        });
      }
      if (!valDepthOk(body.val)) {
        return reply.code(400).send({
          error: "Node val nests beyond the canonical-form depth limit",
        });
      }

      const existing = store.getNode(request.params.id);
      const node: CbpNode = existing
        ? { ...body, v: existing.v + 1, prev: existing.id }
        : { ...body, v: 1, prev: null };

      const combinedLookup = (id: string): CbpNode | undefined =>
        id === node.id ? node : store.getNode(id);
      let containingFrame: FrameConfig | undefined;
      for (const frame of config.frames.values()) {
        if (isInFrameVia(node, frame.id, combinedLookup)) {
          containingFrame = frame;
          break;
        }
      }
      if (!containingFrame) {
        return reply.code(422).send({
          error: "Node lineage does not terminate at any configured frame",
          hint: "ensure the node's lineage chain reaches a frame root that matches a configured frame id",
        });
      }
      if (!checkAcl(containingFrame, request)) {
        return reply
          .code(403)
          .send({ error: "Insufficient ACL for this node's frame" });
      }
      // Capacity (S4a): only a brand-new id adds a live node; an upsert
      // supersedes the existing head and keeps the live count constant.
      if (!existing && store.wouldExceedLiveCap(1)) {
        return reply.code(507).send({
          error: "Store at capacity (max_nodes_per_frame)",
          max_nodes_per_frame: config.serverConfig.max_nodes_per_frame,
        });
      }

      store.loadNode(node);
      emitMutation({
        event: "node_upserted",
        frame_id: containingFrame.id,
        node_id: node.id,
        v: node.v,
      });
      return reply.code(existing ? 200 : 201).send(node);
    }
  );

  // --- DELETE /v1/node/:id ---
  app.delete<{ Params: { id: string } }>("/v1/node/:id", async (request, reply) => {
    const existing = store.getNode(request.params.id);
    if (!existing) {
      return reply.code(404).send({ error: `Node not found: ${request.params.id}` });
    }
    const frame = findFrameForNode(existing, config.frames, store);
    if (frame && !checkAcl(frame, request)) {
      return reply
        .code(403)
        .send({ error: "Insufficient ACL for this node's frame" });
    }
    const removed = store.removeNode(request.params.id);
    if (!removed) {
      return reply.code(404).send({ error: `Node not found: ${request.params.id}` });
    }
    if (frame) {
      emitMutation({
        event: "node_removed",
        frame_id: frame.id,
        node_id: request.params.id,
      });
    }
    return reply.code(204).send();
  });

  // --- GET /v1/edge/:id (v0.5) ---
  app.get<{ Params: { id: string } }>("/v1/edge/:id", async (request, reply) => {
    const edge = store.getEdge(request.params.id);
    if (!edge) {
      return reply.code(404).send({ error: `Edge not found: ${request.params.id}` });
    }
    const srcNode = store.getNode(edge.src);
    if (!srcNode) {
      return reply
        .code(404)
        .send({ error: `Edge src node missing: ${edge.src}` });
    }
    const frame = findFrameForNode(srcNode, config.frames, store);
    if (!frame) {
      return reply
        .code(404)
        .send({ error: `Edge not in any configured frame: ${request.params.id}` });
    }
    if (!checkAcl(frame, request)) {
      return reply.code(403).send({ error: "Insufficient ACL for this edge's frame" });
    }
    return reply.send(edge);
  });

  // --- POST /v1/edge (v0.8: now ACL-enforced) ---
  // Strict insert: 409 if the id already exists (use PUT /v1/edge/:id for
  // upsert). Requires the src node to exist and to belong to a configured
  // frame the caller has ACL for (422/403 otherwise). Prior releases
  // silently accepted edges with non-existent or cross-frame src nodes —
  // v0.8 closes that gap, mirroring the frame-root containment enforced
  // on POST /v1/node since v0.6.
  app.post<{ Body: unknown }>("/v1/edge", async (request, reply) => {
    if (exceedsDepth(request.body, MAX_EDGE_BODY_DEPTH)) {
      return reply.code(400).send({ error: "Invalid edge", details: "conditional nesting exceeds max depth" });
    }
    const parsed = CbpEdge.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid edge", details: parsed.error.issues });
    }
    const edge = parsed.data;

    if (store.getEdge(edge.id)) {
      return reply.code(409).send({
        error: `Edge with id "${edge.id}" already exists`,
        hint: "use PUT /v1/edge/:id for upserts",
      });
    }

    const srcNode = store.getNode(edge.src);
    if (!srcNode) {
      return reply.code(422).send({
        error: `Edge src node "${edge.src}" does not exist`,
      });
    }
    const frame = findFrameForNode(srcNode, config.frames, store);
    if (!frame) {
      return reply.code(422).send({
        error: `Edge src "${edge.src}" is not in any configured frame`,
      });
    }
    if (!checkAcl(frame, request)) {
      return reply
        .code(403)
        .send({ error: "Insufficient ACL for this edge's frame" });
    }

    store.loadEdge(edge);
    emitMutation({
      event: "edge_upserted",
      frame_id: frame.id,
      edge_id: edge.id,
      v: edge.v,
    });
    return reply.code(201).send(edge);
  });

  // --- PUT /v1/edge/:id (v0.8) ---
  // Idempotent last-writer-wins upsert for edges, paralleling PUT /v1/node/:id.
  // Server computes v and prev; client-supplied values are ignored. v0.8.1
  // relaxes the input schema (CbpEdgeInput) so clients may omit v entirely
  // (prev was already optional on CbpEdge). ACL is enforced via the src
  // node's containing frame (same as POST /v1/edge in v0.8+).
  app.put<{ Params: { id: string }; Body: unknown }>(
    "/v1/edge/:id",
    async (request, reply) => {
      if (exceedsDepth(request.body, MAX_EDGE_BODY_DEPTH)) {
        return reply.code(400).send({ error: "Invalid edge", details: "conditional nesting exceeds max depth" });
      }
      const parsed = CbpEdgeInput.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "Invalid edge", details: parsed.error.issues });
      }
      const body = parsed.data;
      if (body.id !== request.params.id) {
        return reply.code(400).send({
          error: `body.id "${body.id}" does not match URL id "${request.params.id}"`,
        });
      }

      const existing = store.getEdge(request.params.id);
      const edge: CbpEdge = existing
        ? { ...body, v: existing.v + 1, prev: existing.id }
        : { ...body, v: 1, prev: null };

      const srcNode = store.getNode(edge.src);
      if (!srcNode) {
        return reply.code(422).send({
          error: `Edge src node "${edge.src}" does not exist`,
        });
      }
      const frame = findFrameForNode(srcNode, config.frames, store);
      if (!frame) {
        return reply.code(422).send({
          error: `Edge src "${edge.src}" is not in any configured frame`,
        });
      }
      if (!checkAcl(frame, request)) {
        return reply
          .code(403)
          .send({ error: "Insufficient ACL for this edge's frame" });
      }

      store.loadEdge(edge);
      emitMutation({
        event: "edge_upserted",
        frame_id: frame.id,
        edge_id: edge.id,
        v: edge.v,
      });
      return reply.code(existing ? 200 : 201).send(edge);
    }
  );

  // --- GET /v1/frame/:id/export (v0.5) ---
  // Returns the stored nodes and edges of a frame in the raw (non-resolved)
  // shape — no `active` field on edges. The returned arrays must round-trip
  // byte-identically under canonicalize() across an export -> import -> export
  // cycle.
  app.get<{ Params: { id: string } }>(
    "/v1/frame/:id/export",
    async (request, reply) => {
      const frameConfig = config.frames.get(request.params.id);
      if (!frameConfig) {
        return reply.code(404).send({ error: `Frame not found: ${request.params.id}` });
      }
      if (!checkAcl(frameConfig, request)) {
        return reply.code(403).send({ error: "Insufficient ACL for this frame" });
      }

      const nodes = store
        .getAllNodes()
        .filter((n) => isInFrame(n, frameConfig.id, store));
      const edges = store.getAllEdges().filter((e) => {
        const src = store.getNode(e.src);
        return src && isInFrame(src, frameConfig.id, store);
      });

      return reply.send({
        frame_id: frameConfig.id,
        exported_at: new Date().toISOString(),
        nodes,
        edges,
      });
    }
  );

  // --- POST /v1/frame/:id/import (v0.5) ---
  // Two-pass validation: (1) parse every node/edge with Zod, (2) verify every
  // lineage and every edge src/tgt resolves against the union of existing and
  // incoming node ids. If any error is found, 422 with a structured error
  // array and nothing is inserted. Idempotent on existing ids.
  app.post<{ Params: { id: string }; Body: unknown }>(
    "/v1/frame/:id/import",
    async (request, reply) => {
      const frameConfig = config.frames.get(request.params.id);
      if (!frameConfig) {
        return reply.code(404).send({ error: `Frame not found: ${request.params.id}` });
      }
      if (!checkAcl(frameConfig, request)) {
        return reply.code(403).send({ error: "Insufficient ACL for this frame" });
      }

      const body = request.body as { nodes?: unknown[]; edges?: unknown[] } | null;
      if (
        !body ||
        typeof body !== "object" ||
        !Array.isArray(body.nodes) ||
        !Array.isArray(body.edges)
      ) {
        return reply
          .code(400)
          .send({ error: "import body must include nodes[] and edges[] arrays" });
      }

      type ImportError = {
        index: number;
        kind: "node" | "edge";
        issues: unknown;
      };
      const errors: ImportError[] = [];
      const validNodes: CbpNode[] = [];
      const validEdges: CbpEdge[] = [];

      for (let i = 0; i < body.nodes.length; i++) {
        const parsed = CbpNode.safeParse(body.nodes[i]);
        if (!parsed.success) {
          errors.push({ index: i, kind: "node", issues: parsed.error.issues });
        } else if (!valDepthOk(parsed.data.val)) {
          errors.push({
            index: i,
            kind: "node",
            issues: [
              { message: "val nests beyond the canonical-form depth limit" },
            ],
          });
        } else {
          validNodes.push(parsed.data);
        }
      }
      for (let i = 0; i < body.edges.length; i++) {
        const parsed = CbpEdge.safeParse(body.edges[i]);
        if (parsed.success) validEdges.push(parsed.data);
        else errors.push({ index: i, kind: "edge", issues: parsed.error.issues });
      }

      if (errors.length === 0) {
        const combinedNodes = new Map<string, CbpNode>();
        for (const n of store.getAllNodes()) combinedNodes.set(n.id, n);
        for (const n of validNodes) combinedNodes.set(n.id, n);
        const lookup = (id: string): CbpNode | undefined =>
          combinedNodes.get(id);

        for (const [i, n] of validNodes.entries()) {
          if (n.lineage !== null && !combinedNodes.has(n.lineage)) {
            errors.push({
              index: i,
              kind: "node",
              issues: [
                { message: `lineage references unknown id: ${n.lineage}` },
              ],
            });
            continue;
          }
          // Frame-containment check (v0.5): reject nodes whose lineage chain
          // does not terminate at the frame being imported into. Without this
          // an authenticated caller for frame A could plant nodes that claim
          // lineage into frame B, bypassing frame B's acl_tags on read.
          if (!isInFrameVia(n, frameConfig.id, lookup)) {
            errors.push({
              index: i,
              kind: "node",
              issues: [
                {
                  message: `node lineage does not terminate at frame "${frameConfig.id}"`,
                },
              ],
            });
          }
        }
        for (const [i, e] of validEdges.entries()) {
          if (!combinedNodes.has(e.src)) {
            errors.push({
              index: i,
              kind: "edge",
              issues: [{ message: `src references unknown id: ${e.src}` }],
            });
          }
          if (!combinedNodes.has(e.tgt)) {
            errors.push({
              index: i,
              kind: "edge",
              issues: [{ message: `tgt references unknown id: ${e.tgt}` }],
            });
          }
          // Frame-containment check (v0.5): edge.src must be in this frame.
          // The tgt may cross frames (consistent with /export's edge filter).
          const src = combinedNodes.get(e.src);
          if (src && !isInFrameVia(src, frameConfig.id, lookup)) {
            errors.push({
              index: i,
              kind: "edge",
              issues: [
                {
                  message: `edge src "${e.src}" is not in frame "${frameConfig.id}"`,
                },
              ],
            });
          }
        }
      }

      if (errors.length > 0) {
        return reply
          .code(422)
          .send({ nodes_accepted: 0, edges_accepted: 0, errors });
      }

      // Capacity (S4a): count ids not already present — those are the new
      // live nodes this import would add. Idempotent re-import (all ids
      // known) adds zero and is never rejected.
      const newNodeCount = validNodes.filter(
        (n) => !store.getNode(n.id)
      ).length;
      if (store.wouldExceedLiveCap(newNodeCount)) {
        return reply.code(507).send({
          error: "Import would exceed store capacity (max_nodes_per_frame)",
          max_nodes_per_frame: config.serverConfig.max_nodes_per_frame,
          new_nodes: newNodeCount,
        });
      }

      for (const n of validNodes) store.loadNode(n);
      for (const e of validEdges) store.loadEdge(e);

      emitMutation({
        event: "import_committed",
        frame_id: frameConfig.id,
        nodes: validNodes.length,
        edges: validEdges.length,
      });

      return reply.send({
        nodes_accepted: validNodes.length,
        edges_accepted: validEdges.length,
        errors: [],
      });
    }
  );

  // --- POST /v1/frame/:id/eval ---
  app.post<{ Params: { id: string } }>(
    "/v1/frame/:id/eval",
    async (request, reply) => {
      const frameConfig = config.frames.get(request.params.id);
      if (!frameConfig) {
        return reply.code(404).send({ error: `Frame not found: ${request.params.id}` });
      }
      if (!checkAcl(frameConfig, request)) {
        return reply
          .code(403)
          .send({ error: "Insufficient ACL for this frame" });
      }

      const allNodes = store.getAllNodes().filter((n) => isInFrame(n, frameConfig.id, store));
      const allEdges = store.getAllEdges().filter((e) => {
        const src = store.getNode(e.src);
        return src && isInFrame(src, frameConfig.id, store);
      });

      const resolved = resolveFrame({ frame: frameConfig, nodes: allNodes, edges: allEdges });
      return resolved;
    }
  );

  // --- POST /v1/frame/:id/ingest (v0.11) — structured facts → graph + memory index ---
  app.post<{ Params: { id: string }; Body: unknown }>("/v1/frame/:id/ingest", async (request, reply) => {
    const frameConfig = config.frames.get(request.params.id);
    if (!frameConfig) return reply.code(404).send({ error: `Frame not found: ${request.params.id}` });
    if (!checkAcl(frameConfig, request)) return reply.code(403).send({ error: "Insufficient ACL for this frame" });
    const body = request.body as { facts?: unknown } | null;
    if (!body || !Array.isArray(body.facts)) {
      return reply.code(400).send({ error: "ingest body must include a facts[] array" });
    }
    // Capacity: facts.length + 1 (the frame anchor may be created). Conservative upper bound.
    if (store.wouldExceedLiveCap(body.facts.length + 1)) {
      return reply.code(507).send({
        error: "Store at capacity (max_nodes_per_frame)",
        max_nodes_per_frame: config.serverConfig.max_nodes_per_frame,
      });
    }
    let r;
    try {
      r = await ingestor.ingestFacts(frameConfig.id, body.facts, getTokenizer(frameConfig.tokenizer));
    } catch (err) {
      if (err instanceof MaxNodesExceededError) {
        return reply.code(507).send({
          error: "Store at capacity (max_nodes_per_frame)",
          max_nodes_per_frame: config.serverConfig.max_nodes_per_frame,
        });
      }
      throw err;
    }
    return reply.send({ frame_id: r.frameId, ingested: r.ingested, node_ids: r.nodeIds, skipped: r.skipped });
  });

  // --- POST /v1/frame/:id/ingest/document (v0.11) — raw document → extract → ingest ---
  // Extraction uses the server's configured LlmClient. With the default EchoLlmClient
  // (no real model) this produces no facts; document ingest is meaningful only when
  // the server is configured with a real extractor LLM (key from env).
  // Per-chunk extractor errors are absorbed internally and surface via extract_stats.failedChunks.
  app.post<{ Params: { id: string }; Body: unknown }>("/v1/frame/:id/ingest/document", async (request, reply) => {
    const frameConfig = config.frames.get(request.params.id);
    if (!frameConfig) return reply.code(404).send({ error: `Frame not found: ${request.params.id}` });
    if (!checkAcl(frameConfig, request)) return reply.code(403).send({ error: "Insufficient ACL for this frame" });
    const body = request.body as { document?: unknown; options?: { maxChars?: number; maxChunks?: number } } | null;
    if (!body || typeof body.document !== "string" || body.document.trim() === "") {
      return reply.code(400).send({ error: "ingest/document body must include a non-empty document string" });
    }
    // Clamp client-supplied chunking options. maxChunks bounds the number of
    // (billed) extractor LLM calls, so an unbounded value is a cost/DoS lever;
    // a tiny maxChars would otherwise explode the chunk count the same way.
    const raw = body.options ?? {};
    const extractOpts = {
      maxChunks: Number.isInteger(raw.maxChunks) ? Math.min(Math.max(1, raw.maxChunks as number), MAX_INGEST_CHUNKS) : undefined,
      maxChars: Number.isInteger(raw.maxChars) ? Math.min(Math.max(MIN_INGEST_CHARS, raw.maxChars as number), MAX_INGEST_CHARS) : undefined,
    };
    let r;
    try {
      r = await ingestor.ingestDocument(
        frameConfig.id, body.document, new LlmExtractor(serverLlm, extractOpts), getTokenizer(frameConfig.tokenizer)
      );
    } catch (err) {
      if (err instanceof MaxNodesExceededError) {
        return reply.code(507).send({
          error: "Store at capacity (max_nodes_per_frame)",
          max_nodes_per_frame: config.serverConfig.max_nodes_per_frame,
        });
      }
      // LlmExtractor absorbs per-chunk LLM/parse errors internally (surfaced via
      // extract_stats.failedChunks), so anything thrown here is an unexpected
      // internal failure — surface it as 500 rather than masking it as a 502
      // "upstream extractor" error. Matches the /ingest sibling.
      throw err;
    }
    return reply.send({
      frame_id: r.frameId, ingested: r.ingested, node_ids: r.nodeIds, chunks: r.extract?.chunks, extract_stats: r.extract,
    });
  });

  // --- POST /v1/frame/:id/recall (v0.11) — embed → govern → assemble-to-budget ---
  app.post<{ Params: { id: string }; Body: unknown }>("/v1/frame/:id/recall", async (request, reply) => {
    const frameConfig = config.frames.get(request.params.id);
    if (!frameConfig) return reply.code(404).send({ error: `Frame not found: ${request.params.id}` });
    if (!checkAcl(frameConfig, request)) return reply.code(403).send({ error: "Insufficient ACL for this frame" });
    const body = request.body as { query?: unknown; k?: number; budget?: number; tags?: unknown; min_score?: number } | null;
    if (!body || typeof body.query !== "string" || body.query.trim() === "") {
      return reply.code(400).send({ error: "recall body must include a non-empty query string" });
    }
    const budget = Math.max(0, Math.min(
      typeof body.budget === "number" && Number.isFinite(body.budget) ? body.budget : frameConfig.max_token_budget,
      frameConfig.max_token_budget
    ));
    const filterTags = Array.isArray(body.tags)
      ? (body.tags as unknown[]).filter((t): t is string => typeof t === "string" && !t.startsWith("frame:"))
      : undefined;
    const ctx = await pipeline.recall(body.query, {
      scopeTags: [`frame:${frameConfig.id}`],
      budget,
      tokenizer: getTokenizer(frameConfig.tokenizer),
      k: Number.isInteger(body.k) && (body.k as number) > 0 ? body.k : undefined,
      filterTags,
      minScore: typeof body.min_score === "number" ? body.min_score : undefined,
    });
    return reply.send({
      frame_id: frameConfig.id, query: body.query, budget: ctx.budget, tokens_used: ctx.tokensUsed,
      block: ctx.block, entries: ctx.entries, dropped: ctx.dropped,
    });
  });

  return {
    app,
    store,
    router,
    decay,
    streamManager,
    memoryStore,
    async start(): Promise<string> {
      decay.start(store);
      const address = await app.listen({ port: config.port, host: config.host });
      return address;
    },
    async stop(): Promise<void> {
      decay.stop();
      streamManager.shutdown();
      if (store instanceof PersistentGraphStore) {
        await store.close();
      }
      await app.close();
    },
  };
}

/**
 * Whether a node `val` is within the canonical-form depth limit (S4b). A
 * deeper value would overflow the stack when canonicalize() runs (id
 * derivation, serialization, persistence), so writes reject it up front.
 */
function valDepthOk(val: unknown): boolean {
  try {
    canonicalize(val);
    return true;
  } catch (err) {
    if (err instanceof CanonicalizeError) return false;
    throw err;
  }
}

/**
 * Iterative (stack-safe) maximum-nesting check. Rejects pathologically deep
 * request bodies — notably edge `conditional` trees — BEFORE Zod's recursive
 * validator runs: `Condition` is a `z.lazy()` union, and safeParse on a
 * multi-thousand-deep nest overflows the stack (turning a 400 into a 500, and
 * later a stored poison pill that crashes resolveFrame). Iterative so the
 * guard itself can never overflow.
 */
function exceedsDepth(value: unknown, max: number): boolean {
  const stack: Array<{ v: unknown; d: number }> = [{ v: value, d: 0 }];
  while (stack.length > 0) {
    const top = stack.pop();
    if (top === undefined) break;
    const { v, d } = top;
    if (d > max) return true;
    if (v !== null && typeof v === "object") {
      for (const child of Object.values(v as Record<string, unknown>)) {
        stack.push({ v: child, d: d + 1 });
      }
    }
  }
  return false;
}

// Defensive bounds for the write surface.
const MAX_EDGE_BODY_DEPTH = 64;   // edge conditional nesting (matches MAX_CONDITION_DEPTH)
const MAX_INGEST_CHUNKS = 64;     // bounds billed extractor LLM calls per document
const MAX_INGEST_CHARS = 50_000;  // per-chunk character cap
const MIN_INGEST_CHARS = 200;     // floor so a tiny maxChars can't explode the chunk count

/** Return the first configured frame that contains this node, or undefined. */
function findFrameForNode(
  node: CbpNode,
  frames: Map<string, FrameConfig>,
  store: GraphStore
): FrameConfig | undefined {
  for (const frame of frames.values()) {
    if (isInFrame(node, frame.id, store)) return frame;
  }
  return undefined;
}

/** Check if a node belongs to a specific frame by walking its lineage. */
function isInFrame(node: CbpNode, frameId: string, store: GraphStore): boolean {
  return isInFrameVia(node, frameId, (id) => store.getNode(id));
}

/**
 * Frame-containment walk generalized over a node lookup function. Used by
 * /import to validate lineage across the union of existing + incoming nodes
 * before any of the incoming nodes have been persisted.
 */
function isInFrameVia(
  node: CbpNode,
  frameId: string,
  lookup: (id: string) => CbpNode | undefined
): boolean {
  let current: CbpNode | undefined = node;
  let depth = 0;
  while (current && depth < 20) {
    if (current.type === "frame") {
      const frameVal = current.val as Record<string, unknown> | undefined;
      if (frameVal && frameVal["name"] === frameId) return true;
      if (current.id === frameId) return true;
    }
    if (!current.lineage) break;
    current = lookup(current.lineage);
    depth++;
  }
  return false;
}

/** Compute a simple frame version from the max v of its nodes. */
function computeFrameVersion(nodes: CbpNode[]): number {
  return Math.max(1, ...nodes.map((n) => n.v));
}

/** Check ACL: if frame has acl_tags, token must match at least one. */
function checkAcl(frame: FrameConfig, request: { headers: Record<string, string | string[] | undefined> }): boolean {
  if (!frame.acl_tags || frame.acl_tags.length === 0) return true;
  const tokenLabel = (request as Record<string, unknown>)["cbpTokenLabel"] as string;
  return frame.acl_tags.some((tag) => tag === `acl:${tokenLabel}`);
}
