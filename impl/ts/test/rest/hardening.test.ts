import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCbpServer, type CbpServer } from "../../src/rest/server.js";
import type { ServerConfig } from "../../src/types/config.js";
import type { FrameConfig } from "../../src/types/frame.js";

const TOKEN = "tok-a";
const serverConfig: ServerConfig = {
  max_nodes_per_frame: 500, max_depth: 8, max_conversations: 10000, default_decay: "epoch", epoch_interval_seconds: 9999,
  decay_factor: 0.85, gc_policy: { strategy: "prune_below_weight", threshold: 0.1 },
  edge_vocabulary: "standard_8", compression: { condensed_threshold: 0.3, signal_min_turns: 3 },
  persistence: { driver: "memory" },
};
const frame = (id: string, acl: string[]): FrameConfig => ({
  id, domain_tags: ["d"], root_weight: 1, root_decay: "none", refresh_policy: "on_demand",
  max_token_budget: 4000, inheritance_mode: "prototypal", conditional_edge_eval: "eager",
  tokenizer: "o200k_base", acl_tags: acl,
});

let server: CbpServer;
beforeAll(async () => {
  server = createCbpServer({
    port: 0, host: "127.0.0.1", serverConfig,
    tokens: new Map([[TOKEN, "alpha"]]),
    frames: new Map([["fa", frame("fa", ["acl:alpha"])]]),
    logLevel: "silent",
  });
  await server.app.ready();
});
afterAll(async () => { await server.stop(); });
const auth = { authorization: `Bearer ${TOKEN}` };

describe("write-surface hardening", () => {
  it("POST /v1/edge rejects an over-deep conditional with 400 (not a 500 from a stack overflow)", async () => {
    let cond: unknown = "always";
    for (let i = 0; i < 500; i++) cond = { not: cond };
    const res = await server.app.inject({
      method: "POST", url: "/v1/edge", headers: auth,
      payload: { id: "e1", src: "n1", tgt: "n2", rel: "requires", v: 1, conditional: cond },
    });
    expect(res.statusCode).toBe(400);
  });

  it("ingest/document clamps a huge client maxChunks to the server cap", async () => {
    const doc = Array.from({ length: 200 }, (_, i) => `P${i} ` + "x".repeat(260)).join("\n\n");
    const res = await server.app.inject({
      method: "POST", url: "/v1/frame/fa/ingest/document", headers: auth,
      payload: { document: doc, options: { maxChunks: 1_000_000, maxChars: 1 } },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // 200 oversize paragraphs would be 200 chunks (= 200 billed LLM calls) uncapped;
    // the server clamps to MAX_INGEST_CHUNKS (64).
    expect(body.extract_stats.chunks).toBe(64);
  });

  it("recall normalizes a negative budget to 0 (invariant tokens_used <= budget holds)", async () => {
    const res = await server.app.inject({
      method: "POST", url: "/v1/frame/fa/recall", headers: auth,
      payload: { query: "anything", budget: -100 },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.budget).toBe(0);
    expect(body.tokens_used).toBe(0);
    expect(body.tokens_used).toBeLessThanOrEqual(body.budget);
  });

  it("recall tolerates a negative k (sanitized, not a crash)", async () => {
    const res = await server.app.inject({
      method: "POST", url: "/v1/frame/fa/recall", headers: auth,
      payload: { query: "anything", k: -1 },
    });
    expect(res.statusCode).toBe(200);
  });
});
