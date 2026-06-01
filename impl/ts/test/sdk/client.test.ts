import { describe, it, expect } from "vitest";
import { CbpClient } from "../../src/sdk/client.js";
import type { CbpNode } from "../../src/types/node.js";

const frameNode: CbpNode = {
  id: "f0000001", type: "frame", val: { name: "test" },
  w: 1.0, decay: "epoch", ttl: null, lineage: null,
  tags: ["domain:trading"], v: 1, prev: null,
};

const btcNode: CbpNode = {
  id: "a0000001", type: "entity", val: "BTC",
  w: 0.9, decay: "epoch", ttl: null, lineage: "f0000001",
  tags: [], v: 1, prev: null,
};

function makeClient(writeAccess = false): CbpClient {
  const client = new CbpClient({
    frameConfig: {
      id: "test_frame", domain_tags: ["trading"], root_weight: 1.0,
      root_decay: "epoch", refresh_policy: "on_demand", max_token_budget: 2000,
      inheritance_mode: "prototypal", conditional_edge_eval: "eager",
      tokenizer: "length_fallback", acl_tags: [],
    },
    writeAccess,
  });
  client.loadNodes([frameNode, btcNode]);
  return client;
}

describe("CbpClient (Embedded SDK, Mode 4)", () => {
  describe("resolve", () => {
    it("resolves a frame with inheritance", () => {
      const client = makeClient();
      const resolved = client.resolve();
      expect(resolved.nodes).toHaveLength(2);
      // BTC should inherit domain:trading tag from frame
      const btc = resolved.nodes.find((n) => n.id === "a0000001");
      expect(btc?.tags).toContain("domain:trading");
    });

    it("resolves with CBQ query", () => {
      const client = makeClient();
      const resolved = client.resolve("type:entity");
      expect(resolved.nodes).toHaveLength(1);
      expect(resolved.nodes[0]?.type).toBe("entity");
    });
  });

  describe("serialize", () => {
    it("serializes at full tier on first call", () => {
      const client = makeClient();
      const result = client.serialize("auto");
      expect(result.actualTier).toBe("full");
      expect(result.tokens).toBeGreaterThan(0);
      expect(result.wire).toBeTruthy();
    });

    it("serializes at condensed on second call with auto", () => {
      const client = makeClient();
      client.serialize("auto"); // first → full
      const result = client.serialize("auto"); // second → condensed
      expect(result.actualTier).toBe("condensed");
    });

    it("respects explicit tier request", () => {
      const client = makeClient();
      const result = client.serialize("signal");
      expect(result.actualTier).toBe("signal");
    });
  });

  describe("budget", () => {
    it("returns token estimates", () => {
      const client = makeClient();
      const budget = client.budget();
      expect(budget.full).toBeGreaterThan(0);
      expect(budget.signal).toBeGreaterThan(0);
    });
  });

  describe("write operations", () => {
    it("throws without write access", () => {
      const client = makeClient(false);
      expect(() => client.upsert("a0000001", { w: 0.5 }, 1)).toThrow("write access");
    });

    it("upserts a node with write access", () => {
      const client = makeClient(true);
      const updated = client.upsert("a0000001", { w: 0.5 }, 1);
      expect(updated.w).toBe(0.5);
      expect(updated.v).toBe(2);
    });

    it("records a prior (agent output)", () => {
      const client = makeClient(true);
      const prior = client.recordPrior({
        val: { action: "long", confidence: 0.74 },
        parentId: "a0000001",
        tags: ["agent:decision"],
        decay: "event",
        ttl: 7200,
      });

      expect(prior.type).toBe("prior");
      expect(prior.lineage).toBe("a0000001");
      expect(prior.id).toMatch(/^[0-9a-f]{8,}$/);
      expect(prior.v).toBe(1);

      // Prior should be in the store
      expect(client.store.getNode(prior.id)).toBeDefined();
    });

    it("throws recordPrior without write access", () => {
      const client = makeClient(false);
      expect(() =>
        client.recordPrior({ val: "test", parentId: "a0000001" })
      ).toThrow("write access");
    });
  });

  describe("decay", () => {
    it("runs a manual sweep", () => {
      const client = makeClient(false);
      const result = client.sweep();
      expect(result.epoch).toBe(1);
      expect(result.nodesDecayed).toBeGreaterThan(0);
    });

    it("triggers event-based reset", () => {
      const client = makeClient(true);
      // Add an event-decay node
      client.store.loadNode({
        id: "b0000001", type: "state", val: { price: 42000 },
        w: 0.3, decay: "event", ttl: null, lineage: "a0000001",
        tags: [], v: 1, prev: null,
      });

      const updated = client.triggerEvent("price_update", ["b0000001"], 1.0);
      expect(updated).toBe(1);
      expect(client.store.getNode("b0000001")?.w).toBe(1.0);
    });
  });

  describe("the spec example (Mode 4)", () => {
    it("reproduces the embedded SDK example from cbp-architecture.html §VI", () => {
      // From the spec:
      // const ctx = new CBPClient('crypto_macro');
      // const frame = await ctx.resolve({ tier: 'condensed' });
      // await ctx.upsert({ type: 'prior', lineage: 'entity:BTC', ... })

      const client = new CbpClient({
        frameConfig: {
          id: "crypto_macro", domain_tags: ["trading", "crypto"],
          root_weight: 1.0, root_decay: "epoch", refresh_policy: "event:price_update",
          max_token_budget: 400, inheritance_mode: "prototypal",
          conditional_edge_eval: "eager", tokenizer: "length_fallback", acl_tags: [],
        },
        writeAccess: true,
      });

      client.loadNodes([frameNode, btcNode]);

      // Resolve the frame
      const resolved = client.resolve();
      expect(resolved.nodes).toHaveLength(2);

      // Agent takes action, records result as prior
      const prior = client.recordPrior({
        val: { action: "long", confidence: 0.74 },
        parentId: "a0000001",
        decay: "event",
        ttl: 7200,
      });

      expect(prior.type).toBe("prior");
      expect(prior.lineage).toBe("a0000001");

      // Now the frame includes the agent's prior
      const resolvedAfter = client.resolve();
      expect(resolvedAfter.nodes).toHaveLength(3);
    });
  });
});
