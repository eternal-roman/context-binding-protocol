import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCbpServer, type CbpServer } from "../../src/rest/server.js";
import type { ServerConfig } from "../../src/types/config.js";

const TEST_TOKEN = "test-token-healthz";

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
        "frame_a",
        {
          id: "frame_a",
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
      [
        "frame_b",
        {
          id: "frame_b",
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
  await server.app.ready();
});

afterAll(async () => {
  await server.stop();
});

describe("GET /healthz (v0.5)", () => {
  it("returns 200 without an Authorization header", async () => {
    const res = await server.app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
  });

  it("returns 200 when an invalid bearer token is supplied", async () => {
    // The probe is unauthenticated; a bad token doesn't matter either way.
    const res = await server.app.inject({
      method: "GET",
      url: "/healthz",
      headers: { authorization: "Bearer nope" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("returns the documented body shape", async () => {
    const res = await server.app.inject({ method: "GET", url: "/healthz" });
    const body = JSON.parse(res.body) as {
      status: string;
      uptime_s: number;
      version: string;
      frames: number;
    };
    expect(body.status).toBe("ok");
    expect(typeof body.uptime_s).toBe("number");
    expect(body.uptime_s).toBeGreaterThanOrEqual(0);
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(body.frames).toBe(2);
  });

  it("does not leak auth checking for other paths", async () => {
    const res = await server.app.inject({ method: "GET", url: "/v1/frames" });
    expect(res.statusCode).toBe(401);
  });
});
