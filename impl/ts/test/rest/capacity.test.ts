/**
 * S4(a) — REST writes must respect max_nodes_per_frame, and S4(b) — a
 * deeply nested `val` must be rejected (400) rather than crash later.
 *
 * `store.loadNode` (the path every REST write uses) bypasses the
 * `liveNodeCount` cap that `insertNode` enforces, so `max_nodes_per_frame`
 * was never enforced on the network surface — an unbounded-write OOM. The
 * fix checks `wouldExceedLiveCap` on the insert paths and returns 507. A
 * separate guard rejects over-deep `val` payloads with 400.
 *
 * @see cbp-architecture.html Section IX — Interface Contract
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCbpServer, type CbpServer } from "../../src/rest/server.js";
import type { LightMyRequestResponse } from "fastify";
import type { ServerConfig } from "../../src/types/config.js";
import type { CbpNode } from "../../src/types/node.js";

const TOKEN = "test-token";

const serverConfig: ServerConfig = {
  max_nodes_per_frame: 3,
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

const frameRoot: CbpNode = {
  id: "facc0001",
  type: "frame",
  val: { name: "cap_frame" },
  w: 1,
  decay: "none",
  ttl: null,
  lineage: null,
  tags: [],
  v: 1,
  prev: null,
};

function entity(id: string, val: unknown = "x"): CbpNode {
  return {
    id,
    type: "entity",
    val,
    w: 0.5,
    decay: "none",
    ttl: null,
    lineage: "facc0001",
    tags: [],
    v: 1,
    prev: null,
  };
}

beforeAll(async () => {
  server = createCbpServer({
    port: 0,
    host: "127.0.0.1",
    serverConfig,
    tokens: new Map([[TOKEN, "cap_user"]]),
    frames: new Map([
      [
        "cap_frame",
        {
          id: "cap_frame",
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
  // Frame root is one live node; cap is 3.
  server.store.loadNode(frameRoot);
  await server.app.ready();
});

afterAll(async () => {
  await server.stop();
});

function post(body: unknown): Promise<LightMyRequestResponse> {
  return server.app.inject({
    method: "POST",
    url: "/v1/node",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    payload: body as object,
  });
}

function put(id: string, body: unknown): Promise<LightMyRequestResponse> {
  return server.app.inject({
    method: "PUT",
    url: `/v1/node/${id}`,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    payload: body as object,
  });
}

function deepVal(depth: number): unknown {
  let v: unknown = 1;
  for (let i = 0; i < depth; i++) v = { a: v };
  return v;
}

describe("REST write capacity enforcement (S4a)", () => {
  it("accepts inserts up to the cap then rejects with 507", async () => {
    // Live = 1 (frame root). Cap = 3 → two more inserts allowed.
    expect((await post(entity("aaaa0001"))).statusCode).toBe(201);
    expect((await post(entity("aaaa0002"))).statusCode).toBe(201);
    // Live = 3 = cap. The next insert must be rejected.
    const over = await post(entity("aaaa0003"));
    expect(over.statusCode).toBe(507);
    expect(server.store.getNode("aaaa0003")).toBeUndefined();
  });

  it("allows a metadata upsert (PUT existing) at the cap — no new live node", async () => {
    // aaaa0001 already exists; PUT supersedes it (net live change 0).
    const res = await put("aaaa0001", entity("aaaa0001", "updated"));
    expect(res.statusCode).toBe(200);
  });

  it("rejects a PUT that would insert a brand-new node past the cap with 507", async () => {
    const res = await put("aaaa0009", entity("aaaa0009"));
    expect(res.statusCode).toBe(507);
    expect(server.store.getNode("aaaa0009")).toBeUndefined();
  });
});

describe("REST write depth enforcement (S4b)", () => {
  it("rejects a node whose val nests beyond the canonical depth limit with 400", async () => {
    const res = await post(entity("bbbb0001", deepVal(500)));
    expect(res.statusCode).toBe(400);
  });
});
