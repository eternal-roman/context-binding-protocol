import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createCbpServer } from "../../src/rest/server.js";
import type { LightMyRequestResponse } from "fastify";
import type { CbpServer } from "../../src/rest/server.js";
import type { CbpNode } from "../../src/types/node.js";
import type { ServerConfig } from "../../src/types/config.js";

const TEST_TOKEN = "test-token-001";

const serverConfig: ServerConfig = {
  max_nodes_per_frame: 500,
  max_depth: 8,
  max_conversations: 10000,
  default_decay: "epoch",
  epoch_interval_seconds: 9999, // don't auto-sweep during tests
  decay_factor: 0.85,
  gc_policy: { strategy: "prune_below_weight", threshold: 0.1 },
  edge_vocabulary: "standard_8",
  compression: { condensed_threshold: 0.3, signal_min_turns: 3 },
  persistence: { driver: "memory" },
};

let server: CbpServer;

beforeAll(async () => {
  server = createCbpServer({
    port: 0, // random available port
    host: "127.0.0.1",
    serverConfig,
    tokens: new Map([[TEST_TOKEN, "test_user"]]),
    frames: new Map([
      [
        "test_frame",
        {
          id: "test_frame",
          domain_tags: ["testing"],
          root_weight: 1.0,
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

  // Seed some data
  const frameNode: CbpNode = {
    id: "f0000001",
    type: "frame",
    val: { name: "test_frame" },
    w: 1.0,
    decay: "none",
    ttl: null,
    lineage: null,
    tags: ["domain:testing"],
    v: 1,
    prev: null,
  };
  server.store.loadNode(frameNode);
  server.store.loadNode({
    id: "a0000001",
    type: "entity",
    val: "TestEntity",
    w: 0.8,
    decay: "none",
    ttl: null,
    lineage: "f0000001",
    tags: [],
    v: 1,
    prev: null,
  });

  await server.app.ready();
});

afterAll(async () => {
  await server.stop();
});

function inject(method: string, url: string, body?: unknown): Promise<LightMyRequestResponse> {
  return server.app.inject({
    method: method as "GET" | "POST" | "DELETE",
    url,
    headers: { authorization: `Bearer ${TEST_TOKEN}` },
    ...(body ? { payload: body } : {}),
  });
}

describe("CBP REST API", () => {
  describe("authentication (G8)", () => {
    it("rejects requests without auth header", async () => {
      const res = await server.app.inject({ method: "GET", url: "/v1/frames" });
      expect(res.statusCode).toBe(401);
    });

    it("rejects invalid tokens", async () => {
      const res = await server.app.inject({
        method: "GET",
        url: "/v1/frames",
        headers: { authorization: "Bearer invalid-token" },
      });
      expect(res.statusCode).toBe(403);
    });

    it("accepts valid tokens", async () => {
      const res = await inject("GET", "/v1/frames");
      expect(res.statusCode).toBe(200);
    });
  });

  describe("GET /v1/frames", () => {
    it("lists available frames", async () => {
      const res = await inject("GET", "/v1/frames");
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { frames: string[] };
      expect(body.frames).toContain("test_frame");
    });
  });

  describe("GET /v1/frame/:id", () => {
    it("returns serialized frame", async () => {
      const res = await inject("GET", "/v1/frame/test_frame?tier=full");
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("application/cbp+json");
    });

    it("returns 404 for unknown frame", async () => {
      const res = await inject("GET", "/v1/frame/nonexistent");
      expect(res.statusCode).toBe(404);
    });
  });

  describe("GET /v1/frame/:id/budget", () => {
    it("returns token estimates", async () => {
      const res = await inject("GET", "/v1/frame/test_frame/budget");
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { estimates: { full: number; condensed: number; signal: number } };
      expect(body.estimates.full).toBeGreaterThan(0);
      expect(body.estimates.signal).toBeGreaterThan(0);
    });
  });

  describe("POST /v1/node", () => {
    it("creates a node", async () => {
      const node: CbpNode = {
        id: "b0000001",
        type: "state",
        val: { price: 42000 },
        w: 0.7,
        decay: "event",
        ttl: 300,
        lineage: "a0000001",
        tags: ["test"],
        v: 1,
        prev: null,
      };
      const res = await inject("POST", "/v1/node", node);
      expect(res.statusCode).toBe(201);
    });

    it("rejects invalid node", async () => {
      const res = await inject("POST", "/v1/node", { invalid: true });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("DELETE /v1/node/:id", () => {
    it("removes a node", async () => {
      server.store.loadNode({
        id: "d0000001",
        type: "state",
        val: "to-delete",
        w: 0.5,
        decay: "none",
        ttl: null,
        lineage: "f0000001",
        tags: [],
        v: 1,
        prev: null,
      });
      const res = await inject("DELETE", "/v1/node/d0000001");
      expect(res.statusCode).toBe(204);
      expect(server.store.getNode("d0000001")).toBeUndefined();
    });

    it("returns 404 for unknown node", async () => {
      const res = await inject("DELETE", "/v1/node/nonexistent");
      expect(res.statusCode).toBe(404);
    });
  });

  describe("POST /v1/frame/:id/eval", () => {
    it("returns the resolved active graph", async () => {
      const res = await inject("POST", "/v1/frame/test_frame/eval");
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { nodes: unknown[]; edges: unknown[] };
      expect(body.nodes).toBeInstanceOf(Array);
      expect(body.edges).toBeInstanceOf(Array);
    });
  });
});
