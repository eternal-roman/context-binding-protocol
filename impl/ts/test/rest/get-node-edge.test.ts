import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCbpServer, type CbpServer } from "../../src/rest/server.js";
import type { LightMyRequestResponse } from "fastify";
import type { ServerConfig } from "../../src/types/config.js";
import type { CbpNode } from "../../src/types/node.js";
import type { CbpEdge } from "../../src/types/edge.js";

const OPEN_TOKEN = "test-token-open";
const OTHER_TOKEN = "test-token-other";

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
    tokens: new Map([
      [OPEN_TOKEN, "open_user"],
      [OTHER_TOKEN, "other_user"],
    ]),
    frames: new Map([
      [
        "open_frame",
        {
          id: "open_frame",
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
      [
        "restricted_frame",
        {
          id: "restricted_frame",
          domain_tags: ["testing"],
          root_weight: 1,
          root_decay: "none",
          refresh_policy: "on_demand",
          max_token_budget: 2000,
          inheritance_mode: "prototypal",
          conditional_edge_eval: "eager",
          tokenizer: "length_fallback",
          acl_tags: ["acl:open_user"],
        },
      ],
    ]),
    logLevel: "silent",
  });

  const openRoot: CbpNode = {
    id: "f1000001",
    type: "frame",
    val: { name: "open_frame" },
    w: 1,
    decay: "none",
    ttl: null,
    lineage: null,
    tags: [],
    v: 1,
    prev: null,
  };
  const restrictedRoot: CbpNode = {
    id: "f2000001",
    type: "frame",
    val: { name: "restricted_frame" },
    w: 1,
    decay: "none",
    ttl: null,
    lineage: null,
    tags: [],
    v: 1,
    prev: null,
  };
  const openChild: CbpNode = {
    id: "a1000001",
    type: "entity",
    val: "OpenEntity",
    w: 0.8,
    decay: "none",
    ttl: null,
    lineage: "f1000001",
    tags: [],
    v: 1,
    prev: null,
  };
  const restrictedChild: CbpNode = {
    id: "a2000001",
    type: "entity",
    val: "RestrictedEntity",
    w: 0.8,
    decay: "none",
    ttl: null,
    lineage: "f2000001",
    tags: [],
    v: 1,
    prev: null,
  };
  const openEdge: CbpEdge = {
    id: "e1000001",
    src: "a1000001",
    tgt: "f1000001",
    rel: "requires",
    strength: 1,
    conditional: "always",
    w: 1,
    decay: "none",
    ttl: null,
    v: 1,
    prev: null,
  };
  const restrictedEdge: CbpEdge = {
    id: "e2000001",
    src: "a2000001",
    tgt: "f2000001",
    rel: "requires",
    strength: 1,
    conditional: "always",
    w: 1,
    decay: "none",
    ttl: null,
    v: 1,
    prev: null,
  };

  server.store.loadNode(openRoot);
  server.store.loadNode(restrictedRoot);
  server.store.loadNode(openChild);
  server.store.loadNode(restrictedChild);
  server.store.loadEdge(openEdge);
  server.store.loadEdge(restrictedEdge);

  await server.app.ready();
});

afterAll(async () => {
  await server.stop();
});

function injectAs(
  token: string,
  method: string,
  url: string
): Promise<LightMyRequestResponse> {
  return server.app.inject({
    method: method as "GET",
    url,
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("GET /v1/node/:id (v0.5)", () => {
  it("returns the stored node in an accessible frame", async () => {
    const res = await injectAs(OPEN_TOKEN, "GET", "/v1/node/a1000001");
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as CbpNode;
    expect(body.id).toBe("a1000001");
    expect(body.val).toBe("OpenEntity");
  });

  it("returns 404 for an unknown id", async () => {
    const res = await injectAs(OPEN_TOKEN, "GET", "/v1/node/deadbeef");
    expect(res.statusCode).toBe(404);
  });

  it("returns 403 when the node's frame rejects the token", async () => {
    const res = await injectAs(OTHER_TOKEN, "GET", "/v1/node/a2000001");
    expect(res.statusCode).toBe(403);
  });

  it("allows access when the token matches one of the frame's acl_tags", async () => {
    const res = await injectAs(OPEN_TOKEN, "GET", "/v1/node/a2000001");
    expect(res.statusCode).toBe(200);
  });

  it("requires authentication", async () => {
    const res = await server.app.inject({ method: "GET", url: "/v1/node/a1000001" });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /v1/edge/:id (v0.5)", () => {
  it("returns the stored edge in an accessible frame", async () => {
    const res = await injectAs(OPEN_TOKEN, "GET", "/v1/edge/e1000001");
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as CbpEdge;
    expect(body.id).toBe("e1000001");
    expect(body.rel).toBe("requires");
  });

  it("returns 404 for an unknown id", async () => {
    const res = await injectAs(OPEN_TOKEN, "GET", "/v1/edge/deadbeef");
    expect(res.statusCode).toBe(404);
  });

  it("returns 403 when the edge's frame rejects the token", async () => {
    const res = await injectAs(OTHER_TOKEN, "GET", "/v1/edge/e2000001");
    expect(res.statusCode).toBe(403);
  });

  it("allows access when the token's label matches one of the frame's acl_tags", async () => {
    const res = await injectAs(OPEN_TOKEN, "GET", "/v1/edge/e2000001");
    expect(res.statusCode).toBe(200);
  });
});

describe("POST /v1/frame/:id/eval empty body (v0.5)", () => {
  it("returns 200 when invoked with an empty application/json body", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: "/v1/frame/open_frame/eval",
      headers: {
        authorization: `Bearer ${OPEN_TOKEN}`,
        "content-type": "application/json",
      },
      payload: "",
    });
    expect(res.statusCode).toBe(200);
  });

  it("returns 200 when invoked with no body at all", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: "/v1/frame/open_frame/eval",
      headers: { authorization: `Bearer ${OPEN_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
  });
});
