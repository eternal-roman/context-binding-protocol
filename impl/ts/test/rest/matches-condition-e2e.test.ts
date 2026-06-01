/**
 * End-to-end: a `matches`-conditioned edge resolves correctly through the live
 * REST handler stack.
 *
 * `re2` is an opt-in engine for the core primitives, registered by
 * createCbpServer (see rest/server.ts). This test exercises the full
 * composition over HTTP — POST /v1/frame/:id/eval runs the resolver, which
 * evaluates the edge's `matches` condition via the registered engine — and
 * proves the engine actually RUNS (not merely that it is registered): a
 * matching pattern yields an active edge, a non-matching pattern yields a
 * dormant one. If no engine were wired into the server, the resolve would throw
 * and this endpoint would 500.
 *
 * @see test/rest/matcher-registration.test.ts — server registers the engine (unit)
 * @see test/resolver/matcher-seam.test.ts — the engine seam behavior (unit)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCbpServer, type CbpServer } from "../../src/rest/server.js";
import type { ServerConfig } from "../../src/types/config.js";
import type { CbpNode } from "../../src/types/node.js";
import type { CbpEdge } from "../../src/types/edge.js";

const TOKEN = "renewal-token";

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
    tokens: new Map([[TOKEN, "renewal_user"]]),
    frames: new Map([
      [
        "renewal",
        {
          id: "renewal",
          domain_tags: ["accounts"],
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

  const frameRoot: CbpNode = {
    id: "f9000001", type: "frame", val: { name: "renewal" },
    w: 1, decay: "none", ttl: null, lineage: null, tags: [], v: 1, prev: null,
  };
  const account: CbpNode = {
    id: "a9000001", type: "entity", val: "Acme Corp",
    w: 0.9, decay: "none", ttl: null, lineage: "f9000001", tags: [], v: 1, prev: null,
  };
  const renewalPrior: CbpNode = {
    id: "p9000001", type: "prior", val: { renewal_outlook: "at_risk" },
    w: 0.6, decay: "none", ttl: null, lineage: "a9000001", tags: [], v: 1, prev: null,
  };
  // Active: "at_risk" matches the alternation.
  const matchingEdge: CbpEdge = {
    id: "e9000001", src: "a9000001", tgt: "f9000001", rel: "correlates", strength: 0.85,
    conditional: { field: "prior:p9000001.val.renewal_outlook", op: "matches", value: "at_risk|churning" },
    w: 1, decay: "none", ttl: null, v: 1, prev: null,
  };
  // Dormant: anchored "^churning$" does not match "at_risk".
  const nonMatchingEdge: CbpEdge = {
    id: "e9000002", src: "a9000001", tgt: "f9000001", rel: "correlates", strength: 0.85,
    conditional: { field: "prior:p9000001.val.renewal_outlook", op: "matches", value: "^churning$" },
    w: 1, decay: "none", ttl: null, v: 1, prev: null,
  };

  server.store.loadNode(frameRoot);
  server.store.loadNode(account);
  server.store.loadNode(renewalPrior);
  server.store.loadEdge(matchingEdge);
  server.store.loadEdge(nonMatchingEdge);

  await server.app.ready();
});

afterAll(async () => {
  await server.stop();
});

describe("matches-conditioned edge resolves over HTTP (POST /v1/frame/:id/eval)", () => {
  it("activates the edge whose pattern matches, dormant for the one that does not", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: "/v1/frame/renewal/eval",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body) as { edges: Array<{ id: string; active: boolean }> };
    const matching = body.edges.find((e) => e.id === "e9000001");
    const nonMatching = body.edges.find((e) => e.id === "e9000002");

    expect(matching?.active).toBe(true);
    expect(nonMatching?.active).toBe(false);
  });
});
