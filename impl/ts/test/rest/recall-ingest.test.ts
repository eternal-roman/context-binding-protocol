import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCbpServer, type CbpServer } from "../../src/rest/server.js";
import type { ServerConfig } from "../../src/types/config.js";
import type { FrameConfig } from "../../src/types/frame.js";

const TOKEN_A = "tok-a", TOKEN_B = "tok-b";
const serverConfig: ServerConfig = {
  max_nodes_per_frame: 500, max_depth: 8, max_conversations: 10000, default_decay: "epoch", epoch_interval_seconds: 9999,
  decay_factor: 0.85, gc_policy: { strategy: "prune_below_weight", threshold: 0.1 },
  edge_vocabulary: "standard_8", compression: { condensed_threshold: 0.3, signal_min_turns: 3 },
  persistence: { driver: "memory" },
}; // memory is optional — omitted here; server applies MemoryConfig defaults
const frame = (id: string, acl: string[]): FrameConfig => ({
  id, domain_tags: ["d"], root_weight: 1, root_decay: "none", refresh_policy: "on_demand",
  max_token_budget: 4000, inheritance_mode: "prototypal", conditional_edge_eval: "eager",
  tokenizer: "o200k_base", acl_tags: acl,
});

let server: CbpServer;
beforeAll(async () => {
  server = createCbpServer({
    port: 0, host: "127.0.0.1", serverConfig,
    tokens: new Map([[TOKEN_A, "alpha"], [TOKEN_B, "beta"]]),
    frames: new Map([["fa", frame("fa", ["acl:alpha"])], ["fb", frame("fb", ["acl:beta"])]]),
    logLevel: "silent",
  });
  await server.app.ready();
});
afterAll(async () => { await server.stop(); });

const auth = (t: string): { authorization: string } => ({ authorization: `Bearer ${t}` });

describe("POST /v1/frame/:id/ingest + /recall", () => {
  it("ingests facts then recalls them as a budget-bounded block", async () => {
    const ing = await server.app.inject({ method: "POST", url: "/v1/frame/fa/ingest", headers: auth(TOKEN_A),
      payload: { facts: [{ type: "state", val: "Acme Corp price climbing", w: 0.9 }, { type: "prior", val: "No Friday deploys" }] } });
    expect(ing.statusCode).toBe(200);
    expect(JSON.parse(ing.body).ingested).toBe(2);

    const rec = await server.app.inject({ method: "POST", url: "/v1/frame/fa/recall", headers: auth(TOKEN_A),
      payload: { query: "account usage price" } });
    expect(rec.statusCode).toBe(200);
    const body = JSON.parse(rec.body);
    expect(body.entries.length).toBeGreaterThan(0);
    expect(body.tokens_used).toBeLessThanOrEqual(4000);
    expect(Array.isArray(body.dropped)).toBe(true);
  });

  it("403 on a frame the caller lacks ACL for; 404 on an unknown frame", async () => {
    expect((await server.app.inject({ method: "POST", url: "/v1/frame/fb/recall", headers: auth(TOKEN_A), payload: { query: "x" } })).statusCode).toBe(403);
    expect((await server.app.inject({ method: "POST", url: "/v1/frame/nope/recall", headers: auth(TOKEN_A), payload: { query: "x" } })).statusCode).toBe(404);
  });

  it("400 on a missing query; 400 on invalid facts", async () => {
    expect((await server.app.inject({ method: "POST", url: "/v1/frame/fa/recall", headers: auth(TOKEN_A), payload: {} })).statusCode).toBe(400);
    expect((await server.app.inject({ method: "POST", url: "/v1/frame/fa/ingest", headers: auth(TOKEN_A), payload: { facts: "nope" } })).statusCode).toBe(400);
  });

  it("frame partition isolation: beta cannot recall alpha's facts (governance)", async () => {
    await server.app.inject({ method: "POST", url: "/v1/frame/fb/ingest", headers: auth(TOKEN_B), payload: { facts: [{ type: "state", val: "clinical vitals only" }] } });
    const rec = await server.app.inject({ method: "POST", url: "/v1/frame/fb/recall", headers: auth(TOKEN_B), payload: { query: "account usage price climbing" } });
    const texts = JSON.parse(rec.body).entries.map((e: { text: string }) => e.text);
    expect(texts.join(" ")).not.toContain("Acme Corp price climbing"); // alpha's fact never leaks into fb
  });

  it("401 without a bearer token", async () => {
    expect((await server.app.inject({ method: "POST", url: "/v1/frame/fa/recall", payload: { query: "x" } })).statusCode).toBe(401);
  });

  it("507 when ingest would exceed store capacity", async () => {
    const tiny = createCbpServer({
      port: 0, host: "127.0.0.1",
      serverConfig: { ...serverConfig, max_nodes_per_frame: 1 },
      tokens: new Map([[TOKEN_A, "alpha"]]),
      frames: new Map([["fa", frame("fa", ["acl:alpha"])]]),
      logLevel: "silent",
    });
    await tiny.app.ready();
    try {
      const res = await tiny.app.inject({ method: "POST", url: "/v1/frame/fa/ingest", headers: auth(TOKEN_A), payload: { facts: [{ type: "state", val: "x" }] } });
      expect(res.statusCode).toBe(507);
    } finally {
      await tiny.stop();
    }
  });
  it("routes an invalid fact in the array to skipped (200, partial success)", async () => {
    const res = await server.app.inject({ method: "POST", url: "/v1/frame/fa/ingest", headers: auth(TOKEN_A),
      payload: { facts: [{ type: "state", val: "a valid fact here" }, { type: "bogus", val: "bad" }] } });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ingested).toBe(1);
    expect(body.skipped).toHaveLength(1);
    expect(body.skipped[0].index).toBe(1);
  });
  it("401 without a bearer token on ingest", async () => {
    expect((await server.app.inject({ method: "POST", url: "/v1/frame/fa/ingest", payload: { facts: [] } })).statusCode).toBe(401);
  });
});

describe("POST /v1/frame/:id/ingest/document", () => {
  it("accepts a document and returns extract stats (the default Echo server LLM extracts nothing)", async () => {
    const res = await server.app.inject({ method: "POST", url: "/v1/frame/fa/ingest/document", headers: auth(TOKEN_A),
      payload: { document: "Priya is on-call. No Friday deploys." } });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty("extract_stats");
    expect(body.extract_stats.chunks).toBeGreaterThan(0);
    expect(body.ingested).toBe(0); // EchoLlmClient yields no JSON facts — this is the route CONTRACT, not extraction quality
  });
  it("400 when document is missing or empty", async () => {
    expect((await server.app.inject({ method: "POST", url: "/v1/frame/fa/ingest/document", headers: auth(TOKEN_A), payload: {} })).statusCode).toBe(400);
    expect((await server.app.inject({ method: "POST", url: "/v1/frame/fa/ingest/document", headers: auth(TOKEN_A), payload: { document: "   " } })).statusCode).toBe(400);
  });
  it("403 / 404 / 401 like the sibling routes", async () => {
    expect((await server.app.inject({ method: "POST", url: "/v1/frame/fb/ingest/document", headers: auth(TOKEN_A), payload: { document: "x" } })).statusCode).toBe(403);
    expect((await server.app.inject({ method: "POST", url: "/v1/frame/nope/ingest/document", headers: auth(TOKEN_A), payload: { document: "x" } })).statusCode).toBe(404);
    expect((await server.app.inject({ method: "POST", url: "/v1/frame/fa/ingest/document", payload: { document: "x" } })).statusCode).toBe(401);
  });
});
