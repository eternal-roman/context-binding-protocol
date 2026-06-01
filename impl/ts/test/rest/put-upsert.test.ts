import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCbpServer, type CbpServer } from "../../src/rest/server.js";
import type { LightMyRequestResponse } from "fastify";
import type { ServerConfig } from "../../src/types/config.js";
import type { CbpNode } from "../../src/types/node.js";
import type { CbpEdge } from "../../src/types/edge.js";

const OPEN_TOKEN = "test-token-put-open";
const OTHER_TOKEN = "test-token-put-other";

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
  id: "f8000001",
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
  id: "f8000002",
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

const seededEntity: CbpNode = {
  id: "a8000001",
  type: "entity",
  val: "Seeded",
  w: 0.8,
  decay: "none",
  ttl: null,
  lineage: "f8000001",
  tags: [],
  v: 1,
  prev: null,
};

const restrictedEntity: CbpNode = {
  id: "a8000099",
  type: "entity",
  val: "RestrictedEntity",
  w: 0.9,
  decay: "none",
  ttl: null,
  lineage: "f8000002",
  tags: [],
  v: 1,
  prev: null,
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

  server.store.loadNode(frameRoot);
  server.store.loadNode(restrictedRoot);
  server.store.loadNode(seededEntity);
  server.store.loadNode(restrictedEntity);
  await server.app.ready();
});

afterAll(async () => {
  await server.stop();
});

function put(
  token: string,
  url: string,
  body: unknown
): Promise<LightMyRequestResponse> {
  return server.app.inject({
    method: "PUT",
    url,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    payload: body as object,
  });
}

function post(
  token: string,
  url: string,
  body: unknown
): Promise<LightMyRequestResponse> {
  return server.app.inject({
    method: "POST",
    url,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    payload: body as object,
  });
}

describe("PUT /v1/node/:id upsert (v0.8)", () => {
  it("inserts a new node with v=1 and returns 201", async () => {
    const node: CbpNode = {
      id: "a8000010",
      type: "entity",
      val: "Fresh",
      w: 0.5,
      decay: "none",
      ttl: null,
      lineage: "f8000001",
      tags: [],
      v: 999, // client-supplied v is ignored
      prev: null,
    };
    const res = await put(OPEN_TOKEN, "/v1/node/a8000010", node);
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as CbpNode;
    expect(body.v).toBe(1);
    expect(body.prev).toBeNull();
    expect(body.val).toBe("Fresh");
  });

  it("upserts an existing node, increments v, and returns 200 with prev set", async () => {
    // seededEntity (a8000001) is already at v=1. First PUT lifts it to v=2.
    const update: CbpNode = {
      ...seededEntity,
      val: "SeededAfterPut",
      v: 1, // ignored by server
      prev: null,
    };
    const res = await put(OPEN_TOKEN, "/v1/node/a8000001", update);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as CbpNode;
    expect(body.v).toBe(2);
    expect(body.prev).toBe("a8000001");
    expect(body.val).toBe("SeededAfterPut");

    // Subsequent PUT of the same id should land at v=3 with prev preserved.
    const again = await put(OPEN_TOKEN, "/v1/node/a8000001", {
      ...body,
      val: "SeededAfterSecondPut",
    });
    expect(again.statusCode).toBe(200);
    const againBody = JSON.parse(again.body) as CbpNode;
    expect(againBody.v).toBe(3);
    expect(againBody.prev).toBe("a8000001");
  });

  it("returns 400 when body.id does not match URL id", async () => {
    const node: CbpNode = {
      id: "a8000010",
      type: "entity",
      val: "MismatchTest",
      w: 0.5,
      decay: "none",
      ttl: null,
      lineage: "f8000001",
      tags: [],
      v: 1,
      prev: null,
    };
    const res = await put(OPEN_TOKEN, "/v1/node/a8000011", node);
    expect(res.statusCode).toBe(400);
  });

  it("returns 422 when lineage does not terminate at any configured frame", async () => {
    const orphan: CbpNode = {
      id: "a8000020",
      type: "entity",
      val: "Orphan",
      w: 0.5,
      decay: "none",
      ttl: null,
      lineage: null,
      tags: [],
      v: 1,
      prev: null,
    };
    const res = await put(OPEN_TOKEN, "/v1/node/a8000020", orphan);
    expect(res.statusCode).toBe(422);
  });

  it("returns 403 when ACL rejects the caller's token for the resolved frame", async () => {
    const node: CbpNode = {
      id: "a8000030",
      type: "entity",
      val: "WouldGoInRestrictedFrame",
      w: 0.5,
      decay: "none",
      ttl: null,
      lineage: "f8000002",
      tags: [],
      v: 1,
      prev: null,
    };
    const res = await put(OTHER_TOKEN, "/v1/node/a8000030", node);
    expect(res.statusCode).toBe(403);
  });

  it("ignores client-supplied v and prev (server always computes)", async () => {
    const stale: CbpNode = {
      id: "a8000040",
      type: "entity",
      val: "FirstWrite",
      w: 0.5,
      decay: "none",
      ttl: null,
      lineage: "f8000001",
      tags: [],
      v: 7,
      prev: "deadbeef",
    };
    const first = await put(OPEN_TOKEN, "/v1/node/a8000040", stale);
    expect(first.statusCode).toBe(201);
    const firstBody = JSON.parse(first.body) as CbpNode;
    expect(firstBody.v).toBe(1);
    expect(firstBody.prev).toBeNull();

    const overwrite = await put(OPEN_TOKEN, "/v1/node/a8000040", {
      ...stale,
      val: "SecondWrite",
      v: 42,
      prev: "cafebabe",
    });
    expect(overwrite.statusCode).toBe(200);
    const overwriteBody = JSON.parse(overwrite.body) as CbpNode;
    expect(overwriteBody.v).toBe(2);
    expect(overwriteBody.prev).toBe("a8000040");
  });

  // v0.8.1: client may omit v and prev entirely — PUT input schema treats
  // them as optional since the server owns the version chain.
  it("accepts a node body that omits v (v0.8.1)", async () => {
    const body = {
      id: "a8000050",
      type: "entity",
      val: "OmitsV",
      w: 0.6,
      decay: "none",
      ttl: null,
      lineage: "f8000001",
      tags: [],
      prev: null,
    };
    const res = await put(OPEN_TOKEN, "/v1/node/a8000050", body);
    expect(res.statusCode).toBe(201);
    const out = JSON.parse(res.body) as CbpNode;
    expect(out.v).toBe(1);
    expect(out.prev).toBeNull();
  });

  it("accepts a node body that omits prev (v0.8.1)", async () => {
    const body = {
      id: "a8000051",
      type: "entity",
      val: "OmitsPrev",
      w: 0.6,
      decay: "none",
      ttl: null,
      lineage: "f8000001",
      tags: [],
      v: 1,
    };
    const res = await put(OPEN_TOKEN, "/v1/node/a8000051", body);
    expect(res.statusCode).toBe(201);
    const out = JSON.parse(res.body) as CbpNode;
    expect(out.v).toBe(1);
    expect(out.prev).toBeNull();
  });

  it("accepts a node body that omits both v and prev (v0.8.1)", async () => {
    const body = {
      id: "a8000052",
      type: "entity",
      val: "OmitsBoth",
      w: 0.6,
      decay: "none",
      ttl: null,
      lineage: "f8000001",
      tags: [],
    };
    const first = await put(OPEN_TOKEN, "/v1/node/a8000052", body);
    expect(first.statusCode).toBe(201);
    const firstOut = JSON.parse(first.body) as CbpNode;
    expect(firstOut.v).toBe(1);
    expect(firstOut.prev).toBeNull();

    const second = await put(OPEN_TOKEN, "/v1/node/a8000052", {
      ...body,
      val: "OmitsBothRewrite",
    });
    expect(second.statusCode).toBe(200);
    const secondOut = JSON.parse(second.body) as CbpNode;
    expect(secondOut.v).toBe(2);
    expect(secondOut.prev).toBe("a8000052");
    expect(secondOut.val).toBe("OmitsBothRewrite");
  });
});

describe("PUT /v1/edge/:id upsert (v0.8)", () => {
  it("inserts a new edge with v=1 and returns 201", async () => {
    const edge: CbpEdge = {
      id: "e8000001",
      src: "a8000001",
      tgt: "f8000001",
      rel: "requires",
      strength: 1,
      conditional: "always",
      w: 1,
      decay: "none",
      ttl: null,
      v: 99,
      prev: null,
    };
    const res = await put(OPEN_TOKEN, "/v1/edge/e8000001", edge);
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as CbpEdge;
    expect(body.v).toBe(1);
    expect(body.prev).toBeNull();
  });

  it("upserts an existing edge and increments v", async () => {
    const edge: CbpEdge = {
      id: "e8000001",
      src: "a8000001",
      tgt: "f8000001",
      rel: "correlates",
      strength: 0.5,
      conditional: "always",
      w: 1,
      decay: "none",
      ttl: null,
      v: 1,
      prev: null,
    };
    const res = await put(OPEN_TOKEN, "/v1/edge/e8000001", edge);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as CbpEdge;
    expect(body.v).toBe(2);
    expect(body.prev).toBe("e8000001");
    expect(body.rel).toBe("correlates");
  });

  it("returns 400 when body.id does not match URL id", async () => {
    const edge: CbpEdge = {
      id: "e8000001",
      src: "a8000001",
      tgt: "f8000001",
      rel: "requires",
      strength: 1,
      conditional: "always",
      w: 1,
      decay: "none",
      ttl: null,
      v: 1,
      prev: null,
    };
    const res = await put(OPEN_TOKEN, "/v1/edge/e8999999", edge);
    expect(res.statusCode).toBe(400);
  });

  it("returns 422 when src node does not exist", async () => {
    const edge: CbpEdge = {
      id: "e8000050",
      src: "deadbeef",
      tgt: "f8000001",
      rel: "requires",
      strength: 1,
      conditional: "always",
      w: 1,
      decay: "none",
      ttl: null,
      v: 1,
      prev: null,
    };
    const res = await put(OPEN_TOKEN, "/v1/edge/e8000050", edge);
    expect(res.statusCode).toBe(422);
  });

  it("returns 403 when ACL rejects the caller for the src's frame", async () => {
    const edge: CbpEdge = {
      id: "e8000060",
      src: "a8000099",
      tgt: "f8000002",
      rel: "requires",
      strength: 1,
      conditional: "always",
      w: 1,
      decay: "none",
      ttl: null,
      v: 1,
      prev: null,
    };
    const res = await put(OTHER_TOKEN, "/v1/edge/e8000060", edge);
    expect(res.statusCode).toBe(403);
  });

  // v0.8.1: edge PUT input schema treats v as optional (prev was already
  // optional on CbpEdge). Clients may omit both.
  it("accepts an edge body that omits v and prev (v0.8.1)", async () => {
    const body = {
      id: "e8000070",
      src: "a8000001",
      tgt: "f8000001",
      rel: "qualifies",
      strength: 1,
      conditional: "always",
      w: 1,
      decay: "none",
      ttl: null,
    };
    const first = await put(OPEN_TOKEN, "/v1/edge/e8000070", body);
    expect(first.statusCode).toBe(201);
    const firstOut = JSON.parse(first.body) as CbpEdge;
    expect(firstOut.v).toBe(1);
    expect(firstOut.prev).toBeNull();

    const second = await put(OPEN_TOKEN, "/v1/edge/e8000070", body);
    expect(second.statusCode).toBe(200);
    const secondOut = JSON.parse(second.body) as CbpEdge;
    expect(secondOut.v).toBe(2);
    expect(secondOut.prev).toBe("e8000070");
  });
});

describe("POST /v1/edge hardened (v0.8)", () => {
  it("returns 422 when src node does not exist", async () => {
    const edge: CbpEdge = {
      id: "e8000100",
      src: "deadbeef",
      tgt: "f8000001",
      rel: "requires",
      strength: 1,
      conditional: "always",
      w: 1,
      decay: "none",
      ttl: null,
      v: 1,
      prev: null,
    };
    const res = await post(OPEN_TOKEN, "/v1/edge", edge);
    expect(res.statusCode).toBe(422);
    expect(server.store.getEdge("e8000100")).toBeUndefined();
  });

  it("returns 403 when ACL rejects the caller's token for the src's frame", async () => {
    const edge: CbpEdge = {
      id: "e8000110",
      src: "a8000099",
      tgt: "f8000002",
      rel: "requires",
      strength: 1,
      conditional: "always",
      w: 1,
      decay: "none",
      ttl: null,
      v: 1,
      prev: null,
    };
    const res = await post(OTHER_TOKEN, "/v1/edge", edge);
    expect(res.statusCode).toBe(403);
  });

  it("returns 409 when edge id already exists", async () => {
    const edge: CbpEdge = {
      id: "e8000120",
      src: "a8000001",
      tgt: "f8000001",
      rel: "requires",
      strength: 1,
      conditional: "always",
      w: 1,
      decay: "none",
      ttl: null,
      v: 1,
      prev: null,
    };
    const first = await post(OPEN_TOKEN, "/v1/edge", edge);
    expect(first.statusCode).toBe(201);
    const second = await post(OPEN_TOKEN, "/v1/edge", edge);
    expect(second.statusCode).toBe(409);
  });
});
