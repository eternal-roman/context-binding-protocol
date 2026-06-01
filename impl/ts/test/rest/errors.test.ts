import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCbpServer, type CbpServer } from "../../src/rest/server.js";
import type { ServerConfig } from "../../src/types/config.js";
import type { CbpNode } from "../../src/types/node.js";

const TEST_TOKEN = "test-token-errors";

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
        "tiny_budget",
        {
          id: "tiny_budget",
          domain_tags: ["testing"],
          root_weight: 1,
          root_decay: "none",
          refresh_policy: "on_demand",
          max_token_budget: 10,
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
    id: "f3000001",
    type: "frame",
    val: { name: "tiny_budget" },
    w: 1,
    decay: "none",
    ttl: null,
    lineage: null,
    tags: ["domain:testing"],
    v: 1,
    prev: null,
  };
  server.store.loadNode(frameRoot);

  for (let i = 0; i < 30; i++) {
    const padded = i.toString().padStart(7, "0");
    server.store.loadNode({
      id: `b${padded}`,
      type: "entity",
      val: `Entity${i}LotsOfContentToExceedTinyBudgetDefinitely`,
      w: 0.9,
      decay: "epoch",
      ttl: null,
      lineage: "f3000001",
      tags: ["testing"],
      v: 1,
      prev: null,
    });
  }

  await server.app.ready();
});

afterAll(async () => {
  await server.stop();
});

describe("BudgetExceededError -> HTTP 413 (v0.5)", () => {
  it("returns 413 with a structured body when even Signal tier exceeds max_token_budget", async () => {
    const res = await server.app.inject({
      method: "GET",
      url: "/v1/frame/tiny_budget?tier=full",
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.statusCode).toBe(413);
    const body = JSON.parse(res.body) as {
      reason: string;
      estimates: { full: number; condensed: number; signal: number };
      max_token_budget: number;
      suggestion: string;
    };
    expect(body.reason).toBe("budget_exceeded");
    expect(body.max_token_budget).toBe(10);
    expect(body.estimates.full).toBeGreaterThan(10);
    expect(body.estimates.signal).toBeGreaterThan(10);
    expect(typeof body.suggestion).toBe("string");
  });
});

describe("invalid ?tier= -> HTTP 400 (A8)", () => {
  it("rejects an unknown tier with 400, not a 500", async () => {
    const res = await server.app.inject({
      method: "GET",
      url: "/v1/frame/tiny_budget?tier=bogus",
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toMatch(/tier/i);
  });

  it("still serves a valid tier on the same route (validation precedes assembly)", async () => {
    // tiny_budget is intentionally over budget, so a VALID tier yields 413 —
    // proving the new guard rejects only garbage, not legitimate requests.
    const res = await server.app.inject({
      method: "GET",
      url: "/v1/frame/tiny_budget?tier=auto",
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.statusCode).toBe(413);
  });
});
