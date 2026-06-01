import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCbpServer, type CbpServer } from "../../src/rest/server.js";
import type { LightMyRequestResponse } from "fastify";
import type { ServerConfig } from "../../src/types/config.js";
import type { CbpNode } from "../../src/types/node.js";

const TEST_TOKEN = "test-token-cbq";

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

let server: CbpServer;

beforeAll(async () => {
  server = createCbpServer({
    port: 0,
    host: "127.0.0.1",
    serverConfig,
    tokens: new Map([[TEST_TOKEN, "test_user"]]),
    frames: new Map([
      [
        "cbq_frame",
        {
          id: "cbq_frame",
          domain_tags: ["testing"],
          root_weight: 1,
          root_decay: "none",
          refresh_policy: "on_demand",
          max_token_budget: 5000,
          inheritance_mode: "prototypal",
          conditional_edge_eval: "eager",
          tokenizer: "length_fallback",
          acl_tags: [],
        },
      ],
    ]),
    logLevel: "silent",
  });

  const frameRoot: CbpNode = {
    id: "f4000001",
    type: "frame",
    val: { name: "cbq_frame" },
    w: 1,
    decay: "none",
    ttl: null,
    lineage: null,
    tags: ["domain:testing"],
    v: 1,
    prev: null,
  };
  server.store.loadNode(frameRoot);
  server.store.loadNode({
    id: "e4000001",
    type: "entity",
    val: "High",
    w: 0.9,
    decay: "none",
    ttl: null,
    lineage: "f4000001",
    tags: [],
    v: 1,
    prev: null,
  });
  server.store.loadNode({
    id: "e4000002",
    type: "entity",
    val: "Low",
    w: 0.3,
    decay: "none",
    ttl: null,
    lineage: "f4000001",
    tags: [],
    v: 1,
    prev: null,
  });
  server.store.loadNode({
    id: "e4000003",
    type: "entity",
    val: "Medium",
    w: 0.6,
    decay: "none",
    ttl: null,
    lineage: "f4000001",
    tags: [],
    v: 1,
    prev: null,
  });

  await server.app.ready();
});

afterAll(async () => {
  await server.stop();
});

function get(url: string): Promise<LightMyRequestResponse> {
  return server.app.inject({
    method: "GET",
    url,
    headers: { authorization: `Bearer ${TEST_TOKEN}` },
  });
}

describe("GET /v1/frame/:id?cbq=... (v0.6)", () => {
  it("returns all nodes when no cbq param is provided", async () => {
    const res = await get("/v1/frame/cbq_frame?tier=full");
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-cbp-cbq-applied"]).toBeUndefined();
  });

  it("filters the frame by weight predicate", async () => {
    const res = await get("/v1/frame/cbq_frame?tier=full&cbq=w%3E0.5");
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-cbp-cbq-applied"]).toBe("true");
    const wire = JSON.parse(res.body) as { nodes: { id: string; w: number }[] };
    // Root (w=1), High (0.9), Medium (0.6) should remain; Low (0.3) should drop.
    const ids = wire.nodes.map((n) => n.id).sort();
    expect(ids).toContain("f4000001");
    expect(ids).toContain("e4000001");
    expect(ids).toContain("e4000003");
    expect(ids).not.toContain("e4000002");
  });

  it("returns 400 with details on an invalid CBQ query", async () => {
    const res = await get("/v1/frame/cbq_frame?tier=full&cbq=not-a-valid-predicate");
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: string; details: string };
    expect(body.error).toBe("Invalid CBQ query");
    expect(typeof body.details).toBe("string");
  });

  it("combines with tier negotiation — tier=full stays full under cbq", async () => {
    const res = await get("/v1/frame/cbq_frame?tier=full&cbq=w%3E0.5");
    expect(res.headers["content-type"]).toContain("tier=full");
  });
});
