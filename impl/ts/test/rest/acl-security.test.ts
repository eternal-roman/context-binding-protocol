/**
 * CBP-001: Verify ACL enforcement on DELETE /v1/node/:id and POST /v1/frame/:id/eval.
 *
 * Both endpoints previously skipped checkAcl(), allowing any authenticated
 * token to delete nodes or evaluate frames regardless of frame ACL tags.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCbpServer, type CbpServer } from "../../src/rest/server.js";
import type { LightMyRequestResponse } from "fastify";
import type { ServerConfig } from "../../src/types/config.js";
import type { CbpNode } from "../../src/types/node.js";

const ALLOWED_TOKEN = "acl-test-allowed";
const DENIED_TOKEN = "acl-test-denied";

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
      [ALLOWED_TOKEN, "allowed_user"],
      [DENIED_TOKEN, "denied_user"],
    ]),
    frames: new Map([
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
          acl_tags: ["acl:allowed_user"],
        },
      ],
    ]),
    logLevel: "silent",
  });

  // Frame root node
  const frameRoot: CbpNode = {
    id: "f3000001",
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

  // Child node under the restricted frame (for DELETE tests)
  const child: CbpNode = {
    id: "a3000001",
    type: "entity",
    val: "RestrictedChild",
    w: 0.8,
    decay: "none",
    ttl: null,
    lineage: "f3000001",
    tags: [],
    v: 1,
    prev: null,
  };

  server.store.loadNode(frameRoot);
  server.store.loadNode(child);

  await server.app.ready();
});

afterAll(async () => {
  await server.stop();
});

function injectAs(
  token: string,
  method: string,
  url: string,
  body?: unknown
): Promise<LightMyRequestResponse> {
  return server.app.inject({
    method: method as "GET" | "POST" | "DELETE",
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(body ? { payload: body } : {}),
  });
}

describe("CBP-001: DELETE /v1/node/:id ACL enforcement", () => {
  it("returns 403 when the token lacks ACL for the node's frame", async () => {
    // Seed a deletable node each time so the test is self-contained
    server.store.loadNode({
      id: "del-denied",
      type: "state",
      val: "will-be-denied",
      w: 0.5,
      decay: "none",
      ttl: null,
      lineage: "f3000001",
      tags: [],
      v: 1,
      prev: null,
    });
    const res = await injectAs(DENIED_TOKEN, "DELETE", "/v1/node/del-denied");
    expect(res.statusCode).toBe(403);
    // Node must still exist (not deleted)
    expect(server.store.getNode("del-denied")).toBeDefined();
  });

  it("allows deletion when the token has ACL for the node's frame", async () => {
    server.store.loadNode({
      id: "del-allowed",
      type: "state",
      val: "will-be-deleted",
      w: 0.5,
      decay: "none",
      ttl: null,
      lineage: "f3000001",
      tags: [],
      v: 1,
      prev: null,
    });
    const res = await injectAs(ALLOWED_TOKEN, "DELETE", "/v1/node/del-allowed");
    expect(res.statusCode).toBe(204);
    expect(server.store.getNode("del-allowed")).toBeUndefined();
  });

  it("returns 404 (not 204) for a frameless node, even with a valid token (ACL-bypass regression)", async () => {
    // A node not resolvable to any configured frame (orphan lineage) must NOT be
    // deletable by an authenticated token. Previously the `frame && !checkAcl`
    // short-circuit allowed it; the fix denies with 404, mirroring GET/PATCH.
    server.store.loadNode({
      id: "orphan-del",
      type: "entity",
      val: "OrphanNoFrame",
      w: 0.5,
      decay: "none",
      ttl: null,
      lineage: null,
      tags: [],
      v: 1,
      prev: null,
    });
    const res = await injectAs(DENIED_TOKEN, "DELETE", "/v1/node/orphan-del");
    expect(res.statusCode).toBe(404);
    expect(server.store.getNode("orphan-del")).toBeDefined(); // not deleted
  });
});

describe("CBP-001: POST /v1/frame/:id/eval ACL enforcement", () => {
  it("returns 403 when the token lacks ACL for the frame", async () => {
    const res = await injectAs(DENIED_TOKEN, "POST", "/v1/frame/restricted_frame/eval");
    expect(res.statusCode).toBe(403);
  });

  it("allows eval when the token has ACL for the frame", async () => {
    const res = await injectAs(ALLOWED_TOKEN, "POST", "/v1/frame/restricted_frame/eval");
    expect(res.statusCode).toBe(200);
  });
});
