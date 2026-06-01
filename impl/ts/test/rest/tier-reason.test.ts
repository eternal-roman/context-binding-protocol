import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCbpServer, type CbpServer } from "../../src/rest/server.js";
import type { LightMyRequestResponse } from "fastify";
import type { ServerConfig } from "../../src/types/config.js";
import type { CbpNode } from "../../src/types/node.js";

const TEST_TOKEN = "test-token-tier-reason";

const serverConfig: ServerConfig = {
  max_nodes_per_frame: 500,
  max_depth: 8,
  max_conversations: 10000,
  default_decay: "epoch",
  epoch_interval_seconds: 9999,
  decay_factor: 0.85,
  gc_policy: { strategy: "prune_below_weight", threshold: 0.1 },
  edge_vocabulary: "standard_8",
  compression: { condensed_threshold: 0.3, signal_min_turns: 2 },
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
        "tier_frame",
        {
          id: "tier_frame",
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
    id: "f6000001",
    type: "frame",
    val: { name: "tier_frame" },
    w: 1,
    decay: "none",
    ttl: null,
    lineage: null,
    tags: [],
    v: 1,
    prev: null,
  };
  server.store.loadNode(frameRoot);
  server.store.loadNode({
    id: "e6000001",
    type: "entity",
    val: "Entity",
    w: 0.8,
    decay: "none",
    ttl: null,
    lineage: "f6000001",
    tags: [],
    v: 1,
    prev: null,
  });

  await server.app.ready();
});

afterAll(async () => {
  await server.stop();
});

function get(
  url: string,
  conversation: string
): Promise<LightMyRequestResponse> {
  return server.app.inject({
    method: "GET",
    url,
    headers: {
      authorization: `Bearer ${TEST_TOKEN}`,
      "x-cbp-conversation": conversation,
    },
  });
}

describe("X-CBP-Tier-Reason header (v0.7)", () => {
  it("reports 'client_requested' when the caller specifies a tier", async () => {
    const res = await get("/v1/frame/tier_frame?tier=full", "conv_1");
    expect(res.headers["x-cbp-tier-reason"]).toBe("client_requested");
  });

  it("reports 'first_turn' on initial auto request for a conversation", async () => {
    const res = await get("/v1/frame/tier_frame?tier=auto", "conv_new");
    expect(res.headers["x-cbp-tier-reason"]).toBe("first_turn");
  });

  it("reports 'condensed_default' on subsequent turns before the signal threshold", async () => {
    // Prime conv_condensed with a full tier.
    await get("/v1/frame/tier_frame?tier=auto", "conv_condensed");
    // Second turn: between first_turn and signal_min_turns=2.
    const res = await get("/v1/frame/tier_frame?tier=auto", "conv_condensed");
    expect(res.headers["x-cbp-tier-reason"]).toBe("condensed_default");
  });

  it("reports 'signal_threshold_met' after signal_min_turns of condensed", async () => {
    // Prime conv_signal with a full tier, then enough condensed turns.
    await get("/v1/frame/tier_frame?tier=auto", "conv_signal"); // first_turn -> full
    await get("/v1/frame/tier_frame?tier=auto", "conv_signal"); // condensed_default
    await get("/v1/frame/tier_frame?tier=auto", "conv_signal"); // condensed_default (turn 2)
    const res = await get("/v1/frame/tier_frame?tier=auto", "conv_signal");
    expect(res.headers["x-cbp-tier-reason"]).toBe("signal_threshold_met");
  });
});
