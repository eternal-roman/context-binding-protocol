/**
 * S1 — GET /v1/frame/:id/budget must enforce the frame ACL.
 *
 * Every other frame-scoped route (GET /v1/frame/:id, /eval, /export,
 * /import) checks `checkAcl`. The /budget route did not, so any holder of
 * a valid bearer token could read token-count / structural estimates for
 * an ACL-restricted frame — an information-disclosure bypass. This test
 * pins the 403 for an unauthorized caller and the 200 for an authorized
 * one.
 *
 * @see cbp-architecture.html Section IX — per-frame ACL tags
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCbpServer, type CbpServer } from "../../src/rest/server.js";
import type { LightMyRequestResponse } from "fastify";
import type { ServerConfig } from "../../src/types/config.js";
import type { CbpNode } from "../../src/types/node.js";

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

const openRoot: CbpNode = {
  id: "f6000001",
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
  id: "f6000002",
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

  server.store.loadNode(openRoot);
  server.store.loadNode(restrictedRoot);

  await server.app.ready();
});

afterAll(async () => {
  await server.stop();
});

function getBudget(token: string, frameId: string): Promise<LightMyRequestResponse> {
  return server.app.inject({
    method: "GET",
    url: `/v1/frame/${frameId}/budget`,
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("GET /v1/frame/:id/budget ACL enforcement (S1)", () => {
  it("returns 403 when an unauthorized token requests a restricted frame's budget", async () => {
    const res = await getBudget(OTHER_TOKEN, "restricted_frame");
    expect(res.statusCode).toBe(403);
  });

  it("returns 200 when an authorized token requests the restricted frame's budget", async () => {
    const res = await getBudget(OPEN_TOKEN, "restricted_frame");
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { frame_id: string };
    expect(body.frame_id).toBe("restricted_frame");
  });

  it("returns 200 for an open (no-ACL) frame regardless of token", async () => {
    const res = await getBudget(OTHER_TOKEN, "open_frame");
    expect(res.statusCode).toBe(200);
  });

  it("still returns 404 for an unknown frame", async () => {
    const res = await getBudget(OPEN_TOKEN, "no_such_frame");
    expect(res.statusCode).toBe(404);
  });
});
