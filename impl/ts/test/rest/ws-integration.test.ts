/**
 * Tests the mutation-event path end-to-end without spinning up a real
 * WebSocket. We subscribe a fake subscriber directly against the server's
 * exposed `streamManager`, then inject mutations via `app.inject`, and
 * assert that the subscribed `send` function received the expected JSON
 * envelope. The real Fastify WS route is tested for behavior (subscribe /
 * close / auth rejection) by existing unit tests on `StreamManager`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCbpServer, type CbpServer } from "../../src/rest/server.js";
import type { LightMyRequestResponse } from "fastify";
import type { ServerConfig } from "../../src/types/config.js";
import type { CbpNode } from "../../src/types/node.js";
import type { CbpEdge } from "../../src/types/edge.js";
import type { MutationEvent } from "../../src/ws/stream.js";

const OPEN_TOKEN = "test-token-events";

const serverConfig: ServerConfig = {
  max_nodes_per_frame: 500,
  max_depth: 8,
  max_conversations: 10000,
  default_decay: "epoch",
  epoch_interval_seconds: 9999,
  decay_factor: 0.85,
  gc_policy: { strategy: "prune_below_weight", threshold: 0.1 },
  edge_vocabulary: "standard_8",
  compression: { condensed_threshold: 0.3, signal_min_turns: 3 },
  persistence: { driver: "memory" },
};

const frameRoot: CbpNode = {
  id: "f7000001",
  type: "frame",
  val: { name: "ws_frame" },
  w: 1,
  decay: "none",
  ttl: null,
  lineage: null,
  tags: [],
  v: 1,
  prev: null,
};

const entity: CbpNode = {
  id: "a7000001",
  type: "entity",
  val: "existing",
  w: 0.8,
  decay: "none",
  ttl: null,
  lineage: "f7000001",
  tags: [],
  v: 1,
  prev: null,
};

let server: CbpServer;
let received: MutationEvent[];
let unsubscribe: () => void;

beforeEach(async () => {
  server = createCbpServer({
    port: 0,
    host: "127.0.0.1",
    serverConfig,
    tokens: new Map([[OPEN_TOKEN, "ws_user"]]),
    frames: new Map([
      [
        "ws_frame",
        {
          id: "ws_frame",
          domain_tags: ["testing"],
          root_weight: 1,
          root_decay: "none",
          refresh_policy: "on_demand",
          max_token_budget: 2000,
          inheritance_mode: "prototypal",
          conditional_edge_eval: "eager",
          tokenizer: "length_fallback",
          acl_tags: [],
        },
      ],
    ]),
    logLevel: "silent",
  });
  server.store.loadNode(frameRoot);
  server.store.loadNode(entity);
  await server.app.ready();

  received = [];
  unsubscribe = server.streamManager.subscribe({
    conversationId: "test",
    frameId: "ws_frame",
    preferredTier: "auto",
    send: (data: string): void => {
      received.push(JSON.parse(data) as MutationEvent);
    },
    close: (): void => {},
  });
});

afterEach(async () => {
  unsubscribe();
  await server.stop();
});

function inject(
  method: string,
  url: string,
  body?: unknown
): Promise<LightMyRequestResponse> {
  return server.app.inject({
    method: method as "POST" | "PATCH" | "DELETE",
    url,
    headers: {
      authorization: `Bearer ${OPEN_TOKEN}`,
      "content-type": "application/json",
    },
    ...(body !== undefined ? { payload: body as object } : {}),
  });
}

describe("mutation events on the /v1/stream channel (v0.7)", () => {
  it("emits node_upserted on POST /v1/node", async () => {
    const newNode: CbpNode = { ...entity, id: "a7000010", val: "new" };
    const res = await inject("POST", "/v1/node", newNode);
    expect(res.statusCode).toBe(201);
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({
      event: "node_upserted",
      frame_id: "ws_frame",
      node_id: "a7000010",
      v: 1,
    });
  });

  it("emits node_upserted on PATCH /v1/node/:id", async () => {
    const res = await inject("PATCH", "/v1/node/a7000001", {
      expectedV: 1,
      update: { w: 0.2 },
    });
    expect(res.statusCode).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({
      event: "node_upserted",
      frame_id: "ws_frame",
      node_id: "a7000001",
      v: 2,
    });
  });

  it("emits node_removed on DELETE /v1/node/:id", async () => {
    const res = await inject("DELETE", "/v1/node/a7000001");
    expect(res.statusCode).toBe(204);
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({
      event: "node_removed",
      frame_id: "ws_frame",
      node_id: "a7000001",
    });
  });

  it("emits edge_upserted on POST /v1/edge", async () => {
    const edge: CbpEdge = {
      id: "e7000001",
      src: "a7000001",
      tgt: "f7000001",
      rel: "requires",
      strength: 1,
      conditional: "always",
      w: 1,
      decay: "none",
      ttl: null,
      v: 1,
      prev: null,
    };
    const res = await inject("POST", "/v1/edge", edge);
    expect(res.statusCode).toBe(201);
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({
      event: "edge_upserted",
      frame_id: "ws_frame",
      edge_id: "e7000001",
      v: 1,
    });
  });

  it("emits import_committed on POST /v1/frame/:id/import", async () => {
    const res = await inject("POST", "/v1/frame/ws_frame/import", {
      nodes: [{ ...entity, id: "a7000020", val: "imported" }],
      edges: [],
    });
    expect(res.statusCode).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({
      event: "import_committed",
      frame_id: "ws_frame",
      nodes: 1,
      edges: 0,
    });
  });

  it("does not emit events when a mutation is rejected (409 on duplicate)", async () => {
    // POST the node that already exists — should 409 and NOT emit.
    const res = await inject("POST", "/v1/node", entity);
    expect(res.statusCode).toBe(409);
    expect(received).toHaveLength(0);
  });
});
