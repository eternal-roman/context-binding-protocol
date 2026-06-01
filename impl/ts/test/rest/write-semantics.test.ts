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

const frameRoot: CbpNode = {
  id: "f5000001",
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
  id: "f5000002",
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

const existingNode: CbpNode = {
  id: "e5000001",
  type: "entity",
  val: "Existing",
  w: 0.9,
  decay: "none",
  ttl: null,
  lineage: "f5000001",
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

  server.store.loadNode(frameRoot);
  server.store.loadNode(restrictedRoot);
  server.store.loadNode(existingNode);

  await server.app.ready();
});

afterAll(async () => {
  await server.stop();
});

function post(token: string, body: unknown): Promise<LightMyRequestResponse> {
  return server.app.inject({
    method: "POST",
    url: "/v1/node",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    payload: body as object,
  });
}

function patch(
  token: string,
  id: string,
  body: unknown
): Promise<LightMyRequestResponse> {
  return server.app.inject({
    method: "PATCH",
    url: `/v1/node/${id}`,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    payload: body as object,
  });
}

describe("POST /v1/node strict-insert (v0.6)", () => {
  it("returns 409 when the id already exists", async () => {
    const res = await post(OPEN_TOKEN, existingNode);
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body) as { current_v: number; hint: string };
    expect(body.current_v).toBe(1);
    expect(body.hint).toContain("PATCH");
  });

  it("returns 422 when the node's lineage terminates at no configured frame", async () => {
    const orphan: CbpNode = {
      id: "e5999999",
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
    const res = await post(OPEN_TOKEN, orphan);
    expect(res.statusCode).toBe(422);
    expect(server.store.getNode("e5999999")).toBeUndefined();
  });

  it("returns 403 when ACL rejects the caller for the resolved frame", async () => {
    const restrictedChild: CbpNode = {
      id: "e5000003",
      type: "entity",
      val: "RestrictedChild",
      w: 0.5,
      decay: "none",
      ttl: null,
      lineage: "f5000002",
      tags: [],
      v: 1,
      prev: null,
    };
    const res = await post(OTHER_TOKEN, restrictedChild);
    expect(res.statusCode).toBe(403);
    expect(server.store.getNode("e5000003")).toBeUndefined();
  });

  it("returns 201 for a valid new node whose lineage terminates at a configured frame", async () => {
    const fresh: CbpNode = {
      id: "e5000010",
      type: "entity",
      val: "Fresh",
      w: 0.6,
      decay: "none",
      ttl: null,
      lineage: "f5000001",
      tags: [],
      v: 1,
      prev: null,
    };
    const res = await post(OPEN_TOKEN, fresh);
    expect(res.statusCode).toBe(201);
    expect(server.store.getNode("e5000010")).toBeDefined();
  });
});

describe("PATCH /v1/node/:id CAS (v0.6)", () => {
  it("updates a node and increments v when expectedV matches", async () => {
    const res = await patch(OPEN_TOKEN, "e5000001", {
      expectedV: 1,
      update: { w: 0.5 },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as CbpNode;
    expect(body.v).toBe(2);
    expect(body.w).toBe(0.5);
    // Metadata-only PATCH preserves the content-history link (null here);
    // it must not fabricate a self-referential prev.
    expect(body.prev).toBeNull();
    expect(body.prev).not.toBe(body.id);
  });

  it("returns 409 on version conflict with current_v and expected_v", async () => {
    const res = await patch(OPEN_TOKEN, "e5000001", {
      expectedV: 1,
      update: { w: 0.1 },
    });
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body) as {
      current_v: number;
      expected_v: number;
    };
    expect(body.expected_v).toBe(1);
    expect(body.current_v).toBe(2);
  });

  it("returns 404 when the node id is unknown", async () => {
    const res = await patch(OPEN_TOKEN, "deadbeef", {
      expectedV: 1,
      update: { w: 0.1 },
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 400 when body is malformed (missing expectedV)", async () => {
    const res = await patch(OPEN_TOKEN, "e5000001", { update: { w: 0.1 } });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 when body is malformed (missing update)", async () => {
    const res = await patch(OPEN_TOKEN, "e5000001", { expectedV: 2 });
    expect(res.statusCode).toBe(400);
  });

  it("returns 403 when ACL rejects the caller", async () => {
    // Seed a node in the restricted frame directly (bypassing POST).
    server.store.loadNode({
      id: "e5000099",
      type: "entity",
      val: "RestrictedExisting",
      w: 0.9,
      decay: "none",
      ttl: null,
      lineage: "f5000002",
      tags: [],
      v: 1,
      prev: null,
    });
    const res = await patch(OTHER_TOKEN, "e5000099", {
      expectedV: 1,
      update: { w: 0.5 },
    });
    expect(res.statusCode).toBe(403);
  });
});
