import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCbpServer, type CbpServer } from "../../src/rest/server.js";
import type { LightMyRequestResponse } from "fastify";
import type { CbpServerConfig } from "../../src/rest/server.js";
import { canonicalize } from "../../src/wire/canonical.js";
import type { ServerConfig } from "../../src/types/config.js";
import type { CbpNode } from "../../src/types/node.js";
import type { CbpEdge } from "../../src/types/edge.js";
import type { FrameConfig } from "../../src/types/frame.js";

const OPEN_TOKEN = "test-token-open";
const OTHER_TOKEN = "test-token-other";

const baseServerConfig: ServerConfig = {
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

const openFrame: FrameConfig = {
  id: "account_health",
  domain_tags: ["accounts"],
  root_weight: 1,
  root_decay: "none",
  refresh_policy: "on_demand",
  max_token_budget: 2000,
  inheritance_mode: "prototypal",
  conditional_edge_eval: "eager",
  tokenizer: "length_fallback",
  acl_tags: [],
};

const restrictedFrame: FrameConfig = {
  ...openFrame,
  id: "restricted",
  acl_tags: ["acl:open_user"],
};

const frameRoot: CbpNode = {
  id: "f0d2e8a1",
  type: "frame",
  val: { name: "account_health" },
  w: 1,
  decay: "none",
  ttl: null,
  lineage: null,
  tags: ["domain:accounts"],
  v: 1,
  prev: null,
};

const btcEntity: CbpNode = {
  id: "a7c3f1e2",
  type: "entity",
  val: "Acme Corp",
  w: 0.9,
  decay: "epoch",
  ttl: null,
  lineage: "f0d2e8a1",
  tags: [],
  v: 1,
  prev: null,
};

const priceState: CbpNode = {
  id: "b2c4d5e6",
  type: "state",
  val: { price: 68420 },
  w: 0.8,
  decay: "event",
  ttl: null,
  lineage: "a7c3f1e2",
  tags: [],
  v: 2,
  prev: null,
};

const conditionalEdge: CbpEdge = {
  id: "e1000001",
  src: "a7c3f1e2",
  tgt: "f0d2e8a1",
  rel: "requires",
  strength: 1,
  conditional: {
    field: "state:b2c4d5e6.price",
    op: "gt",
    value: 50000,
  },
  w: 1,
  decay: "none",
  ttl: null,
  v: 1,
  prev: null,
};

function mkServerConfig(): CbpServerConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    serverConfig: baseServerConfig,
    tokens: new Map([
      [OPEN_TOKEN, "open_user"],
      [OTHER_TOKEN, "other_user"],
    ]),
    frames: new Map<string, FrameConfig>([
      [openFrame.id, openFrame],
      [restrictedFrame.id, restrictedFrame],
    ]),
    logLevel: "silent",
  };
}

async function seedOpenFrame(server: CbpServer): Promise<void> {
  server.store.loadNode(frameRoot);
  server.store.loadNode(btcEntity);
  server.store.loadNode(priceState);
  server.store.loadEdge(conditionalEdge);
  await server.app.ready();
}

function injectAs(
  server: CbpServer,
  token: string,
  method: string,
  url: string,
  payload?: unknown
): Promise<LightMyRequestResponse> {
  return server.app.inject({
    method: method as "GET" | "POST",
    url,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    ...(payload !== undefined ? { payload: payload as string | object } : {}),
  });
}

describe("GET /v1/frame/:id/export (v0.5)", () => {
  let server: CbpServer;

  beforeEach(async () => {
    server = createCbpServer(mkServerConfig());
    await seedOpenFrame(server);
  });

  afterEach(async () => {
    await server.stop();
  });

  it("returns nodes and edges in the stored shape (no 'active' on edges)", async () => {
    const res = await injectAs(server, OPEN_TOKEN, "GET", "/v1/frame/account_health/export");
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      frame_id: string;
      exported_at: string;
      nodes: CbpNode[];
      edges: CbpEdge[];
    };
    expect(body.frame_id).toBe("account_health");
    expect(body.exported_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.nodes).toHaveLength(3);
    expect(body.edges).toHaveLength(1);
    for (const edge of body.edges) {
      expect(edge).not.toHaveProperty("active");
    }
  });

  it("returns 404 for unknown frames", async () => {
    const res = await injectAs(server, OPEN_TOKEN, "GET", "/v1/frame/unknown/export");
    expect(res.statusCode).toBe(404);
  });

  it("returns 403 when ACL rejects the caller", async () => {
    const res = await injectAs(server, OTHER_TOKEN, "GET", "/v1/frame/restricted/export");
    expect(res.statusCode).toBe(403);
  });
});

describe("POST /v1/frame/:id/import (v0.5)", () => {
  let server: CbpServer;

  beforeEach(async () => {
    server = createCbpServer(mkServerConfig());
    await server.app.ready();
  });

  afterEach(async () => {
    await server.stop();
  });

  it("accepts a well-formed import and inserts atomically", async () => {
    const payload = {
      frame_id: "account_health",
      exported_at: "2026-04-17T00:00:00Z",
      nodes: [frameRoot, btcEntity, priceState],
      edges: [conditionalEdge],
    };
    const res = await injectAs(server, OPEN_TOKEN, "POST", "/v1/frame/account_health/import", payload);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      nodes_accepted: number;
      edges_accepted: number;
      errors: unknown[];
    };
    expect(body.nodes_accepted).toBe(3);
    expect(body.edges_accepted).toBe(1);
    expect(body.errors).toEqual([]);

    expect(server.store.getNode("a7c3f1e2")).toEqual(btcEntity);
    expect(server.store.getEdge("e1000001")).toEqual(conditionalEdge);
  });

  it("returns 422 and rolls back on malformed nodes", async () => {
    const payload = {
      nodes: [
        frameRoot,
        { id: "bad", type: "entity" }, // missing required fields
      ],
      edges: [],
    };
    const res = await injectAs(server, OPEN_TOKEN, "POST", "/v1/frame/account_health/import", payload);
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body) as {
      nodes_accepted: number;
      edges_accepted: number;
      errors: { index: number; kind: string }[];
    };
    expect(body.nodes_accepted).toBe(0);
    expect(body.edges_accepted).toBe(0);
    expect(body.errors.some((e) => e.kind === "node" && e.index === 1)).toBe(true);
    expect(server.store.getNode("f0d2e8a1")).toBeUndefined(); // rollback
  });

  it("returns 422 when edge src or tgt references an unknown id", async () => {
    const orphanEdge: CbpEdge = {
      ...conditionalEdge,
      id: "e9000001",
      src: "deadbeef",
    };
    const payload = {
      nodes: [frameRoot, btcEntity],
      edges: [orphanEdge],
    };
    const res = await injectAs(server, OPEN_TOKEN, "POST", "/v1/frame/account_health/import", payload);
    expect(res.statusCode).toBe(422);
    expect(server.store.getNode("a7c3f1e2")).toBeUndefined(); // rollback
  });

  it("returns 422 when lineage references an unknown id", async () => {
    const orphanNode: CbpNode = { ...btcEntity, lineage: "deadbeef" };
    const payload = { nodes: [frameRoot, orphanNode], edges: [] };
    const res = await injectAs(server, OPEN_TOKEN, "POST", "/v1/frame/account_health/import", payload);
    expect(res.statusCode).toBe(422);
  });

  it("is idempotent on existing ids", async () => {
    const payload = {
      nodes: [frameRoot, btcEntity],
      edges: [],
    };
    const r1 = await injectAs(server, OPEN_TOKEN, "POST", "/v1/frame/account_health/import", payload);
    expect(r1.statusCode).toBe(200);
    const r2 = await injectAs(server, OPEN_TOKEN, "POST", "/v1/frame/account_health/import", payload);
    expect(r2.statusCode).toBe(200);
    expect(server.store.getAllNodes()).toHaveLength(2);
  });

  it("returns 400 when nodes or edges are missing", async () => {
    const res = await injectAs(server, OPEN_TOKEN, "POST", "/v1/frame/account_health/import", {
      nodes: [],
      // missing edges
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 403 when ACL rejects the caller", async () => {
    const payload = { nodes: [], edges: [] };
    const res = await injectAs(server, OTHER_TOKEN, "POST", "/v1/frame/restricted/import", payload);
    expect(res.statusCode).toBe(403);
  });

  it("rejects nodes whose lineage does not terminate at the imported frame (ACL-bypass regression)", async () => {
    // Attack vector: a caller authenticated for `account_health` tries to plant
    // nodes that claim lineage into the `restricted` frame (to which they do
    // not have ACL). Without frame-root validation, these nodes would land in
    // the store and surface in /eval of the restricted frame.
    const foreignRoot: CbpNode = {
      id: "f9999999",
      type: "frame",
      val: { name: "restricted" },
      w: 1,
      decay: "none",
      ttl: null,
      lineage: null,
      tags: [],
      v: 1,
      prev: null,
    };
    const smugNode: CbpNode = {
      id: "c9999999",
      type: "entity",
      val: "SmuggledEntity",
      w: 0.9,
      decay: "none",
      ttl: null,
      lineage: "f9999999",
      tags: [],
      v: 1,
      prev: null,
    };
    const payload = {
      nodes: [foreignRoot, smugNode],
      edges: [],
    };
    const res = await injectAs(
      server,
      OPEN_TOKEN,
      "POST",
      "/v1/frame/account_health/import",
      payload
    );
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body) as {
      nodes_accepted: number;
      errors: { index: number; kind: string; issues: { message?: string }[] }[];
    };
    expect(body.nodes_accepted).toBe(0);
    expect(body.errors.some((e) => e.kind === "node")).toBe(true);
    expect(server.store.getNode("c9999999")).toBeUndefined();
    expect(server.store.getNode("f9999999")).toBeUndefined();
  });

  it("rejects an edge whose src is not in the imported frame", async () => {
    const foreignRoot: CbpNode = {
      id: "f8888888",
      type: "frame",
      val: { name: "restricted" },
      w: 1,
      decay: "none",
      ttl: null,
      lineage: null,
      tags: [],
      v: 1,
      prev: null,
    };
    // Correct root for the target frame, so only the edge is the violation.
    const smugEdge: CbpEdge = {
      id: "e8888888",
      src: "f8888888",
      tgt: frameRoot.id,
      rel: "requires",
      strength: 1,
      conditional: "always",
      w: 1,
      decay: "none",
      ttl: null,
      v: 1,
      prev: null,
    };
    const payload = {
      nodes: [frameRoot, foreignRoot],
      edges: [smugEdge],
    };
    const res = await injectAs(
      server,
      OPEN_TOKEN,
      "POST",
      "/v1/frame/account_health/import",
      payload
    );
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body) as {
      errors: { index: number; kind: string; issues: { message?: string }[] }[];
    };
    // The foreign root itself is also an invalid node (lineage terminates at
    // a different frame), so we expect errors for both the edge and that node.
    expect(body.errors.some((e) => e.kind === "edge")).toBe(true);
  });
});

describe("export -> import -> export round-trip (v0.5)", () => {
  it("produces byte-identical canonicalize(nodes) and canonicalize(edges) across the cycle", async () => {
    // Server A — seed + export
    const serverA = createCbpServer(mkServerConfig());
    await seedOpenFrame(serverA);
    const exportARes = await injectAs(
      serverA,
      OPEN_TOKEN,
      "GET",
      "/v1/frame/account_health/export"
    );
    expect(exportARes.statusCode).toBe(200);
    const exportA = JSON.parse(exportARes.body) as {
      nodes: CbpNode[];
      edges: CbpEdge[];
    };
    const canonicalNodesA = canonicalize(exportA.nodes);
    const canonicalEdgesA = canonicalize(exportA.edges);
    await serverA.stop();

    // Server B — fresh, import, re-export
    const serverB = createCbpServer(mkServerConfig());
    await serverB.app.ready();
    const importRes = await injectAs(
      serverB,
      OPEN_TOKEN,
      "POST",
      "/v1/frame/account_health/import",
      { nodes: exportA.nodes, edges: exportA.edges }
    );
    expect(importRes.statusCode).toBe(200);
    const exportBRes = await injectAs(
      serverB,
      OPEN_TOKEN,
      "GET",
      "/v1/frame/account_health/export"
    );
    const exportB = JSON.parse(exportBRes.body) as {
      nodes: CbpNode[];
      edges: CbpEdge[];
    };
    await serverB.stop();

    expect(canonicalize(exportB.nodes)).toBe(canonicalNodesA);
    expect(canonicalize(exportB.edges)).toBe(canonicalEdgesA);
  });
});
