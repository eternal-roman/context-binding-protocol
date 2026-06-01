import { describe, it, expect } from "vitest";
import { serializeFrame, estimateTokens, BudgetExceededError } from "../../src/serializer/serializer.js";
import { resolveFrame } from "../../src/resolver/resolver.js";
import type { FrameInput } from "../../src/resolver/resolver.js";
import type { FrameConfig } from "../../src/types/frame.js";
import type { CbpNode } from "../../src/types/node.js";
import type { CbpEdge } from "../../src/types/edge.js";
import { lengthFallbackTokenizer } from "../../src/tokenizer/length-fallback.js";

// Use length_fallback for deterministic, fast tests
const tokenizer = lengthFallbackTokenizer;

function makeFrame(overrides: Partial<FrameConfig> = {}): FrameConfig {
  return {
    id: "test_frame",
    domain_tags: ["testing"],
    root_weight: 1.0,
    root_decay: "none",
    refresh_policy: "on_demand",
    max_token_budget: 2000,
    inheritance_mode: "prototypal",
    conditional_edge_eval: "eager",
    tokenizer: "length_fallback",
    acl_tags: [],
    ...overrides,
  };
}

function makeNode(id: string, overrides: Partial<CbpNode> = {}): CbpNode {
  return {
    id,
    type: "entity",
    val: `node-${id}`,
    w: 0.8,
    decay: "none",
    ttl: null,
    lineage: "f0000001",
    tags: ["domain:testing"],
    v: 1,
    prev: null,
    ...overrides,
  };
}

const frameNode: CbpNode = {
  id: "f0000001",
  type: "frame",
  val: { name: "test_frame" },
  w: 1.0,
  decay: "none",
  ttl: null,
  lineage: null,
  tags: ["domain:testing"],
  v: 1,
  prev: null,
};

describe("Serializer (Invariant #1: Token Budget is Law)", () => {
  describe("Full tier", () => {
    it("serializes a simple frame at full tier", () => {
      const input: FrameInput = {
        frame: makeFrame(),
        nodes: [frameNode, makeNode("a0000001")],
        edges: [],
      };
      const resolved = resolveFrame(input);
      const result = serializeFrame(resolved, 1, { tier: "full", tokenizer });

      expect(result.actualTier).toBe("full");
      expect(result.payload.tier).toBe("full");
      expect(result.tokens).toBeGreaterThan(0);
      expect(result.tokens).toBeLessThanOrEqual(2000);
      expect(result.wire).toBeTruthy();
    });

    it("includes all nodes and active edges", () => {
      const edge: CbpEdge = {
        id: "e0000001",
        src: "a0000001",
        tgt: "b0000001",
        rel: "correlates",
        strength: 0.85,
        conditional: "always",
        w: 1.0,
        decay: "none",
        ttl: null,
        v: 1,
        prev: null,
      };

      const input: FrameInput = {
        frame: makeFrame(),
        nodes: [frameNode, makeNode("a0000001"), makeNode("b0000001")],
        edges: [edge],
      };
      const resolved = resolveFrame(input);
      const result = serializeFrame(resolved, 1, { tier: "full", tokenizer });

      const payload = result.payload as import("../../src/serializer/serializer.js").FullPayload;
      expect(payload.nodes).toHaveLength(3);
      expect(payload.edges).toHaveLength(1);
    });
  });

  describe("Condensed tier", () => {
    it("produces delta output relative to a previous full", () => {
      const input: FrameInput = {
        frame: makeFrame(),
        nodes: [frameNode, makeNode("a0000001", { w: 0.9 })],
        edges: [],
      };
      const resolved = resolveFrame(input);
      const fullResult = serializeFrame(resolved, 1, { tier: "full", tokenizer });

      // Simulate weight change
      const input2: FrameInput = {
        frame: makeFrame(),
        nodes: [frameNode, makeNode("a0000001", { w: 0.7, v: 2 })],
        edges: [],
      };
      const resolved2 = resolveFrame(input2);
      const condensedResult = serializeFrame(resolved2, 2, {
        tier: "condensed",
        tokenizer,
        previousFull: fullResult.payload as import("../../src/serializer/serializer.js").FullPayload,
      });

      expect(condensedResult.actualTier).toBe("condensed");
      const payload = condensedResult.payload as import("../../src/serializer/serializer.js").CondensedPayload;
      expect(payload.delta.nodes_changed).toHaveLength(1);
      expect(payload.delta.nodes_changed[0]?.w).toBe(0.7);
      expect(payload.base_v).toBe(1);
      expect(payload.v).toBe(2);
    });

    it("is smaller than full tier", () => {
      const nodes = [frameNode, ...Array.from({ length: 5 }, (_, i) => makeNode(`n${String(i).padStart(7, "0")}`, { w: 0.5 + i * 0.1 }))];
      const input: FrameInput = { frame: makeFrame(), nodes, edges: [] };
      const resolved = resolveFrame(input);

      const full = serializeFrame(resolved, 1, { tier: "full", tokenizer });

      // Second pass with one change
      const nodes2 = [...nodes];
      const baseNode = nodes2[1];
      if (baseNode) nodes2[1] = { ...baseNode, w: 0.3, v: 2 };
      const input2: FrameInput = { frame: makeFrame(), nodes: nodes2, edges: [] };
      const resolved2 = resolveFrame(input2);

      const condensed = serializeFrame(resolved2, 2, {
        tier: "condensed",
        tokenizer,
        previousFull: full.payload as import("../../src/serializer/serializer.js").FullPayload,
      });

      expect(condensed.tokens).toBeLessThan(full.tokens);
    });
  });

  describe("Signal tier", () => {
    it("produces compact id+w+trend output", () => {
      const input: FrameInput = {
        frame: makeFrame(),
        nodes: [frameNode, makeNode("a0000001")],
        edges: [],
      };
      const resolved = resolveFrame(input);
      const result = serializeFrame(resolved, 1, { tier: "signal", tokenizer });

      expect(result.actualTier).toBe("signal");
      const payload = result.payload as import("../../src/serializer/serializer.js").SignalPayload;
      expect(payload.nodes).toHaveLength(2);
      expect(payload.nodes[0]).toHaveProperty("id");
      expect(payload.nodes[0]).toHaveProperty("w");
      expect(payload.nodes[0]).toHaveProperty("trend");
    });

    it("is much smaller than full tier", () => {
      const nodes = [frameNode, ...Array.from({ length: 10 }, (_, i) => makeNode(`n${String(i).padStart(7, "0")}`))];
      const input: FrameInput = { frame: makeFrame(), nodes, edges: [] };
      const resolved = resolveFrame(input);

      const full = serializeFrame(resolved, 1, { tier: "full", tokenizer });
      const signal = serializeFrame(resolved, 1, { tier: "signal", tokenizer });

      expect(signal.tokens).toBeLessThan(full.tokens * 0.5);
    });
  });

  describe("token budget enforcement", () => {
    it("drops from full to condensed when over budget", () => {
      // Create a frame with many nodes and a tight budget
      const nodes = [frameNode, ...Array.from({ length: 20 }, (_, i) =>
        makeNode(`n${String(i).padStart(7, "0")}`, { val: `data-${i}-${"x".repeat(50)}` })
      )];
      const input: FrameInput = { frame: makeFrame({ max_token_budget: 200 }), nodes, edges: [] };
      const resolved = resolveFrame(input);

      const result = serializeFrame(resolved, 1, { tier: "full", tokenizer });

      // Should have dropped tier or pruned to fit within 200 tokens
      expect(result.tokens).toBeLessThanOrEqual(200);
    });

    it("prunes lowest-weight nodes first when over budget", () => {
      const nodes = [
        frameNode,
        makeNode("high0001", { w: 0.95, val: "important-data" }),
        makeNode("low00001", { w: 0.15, val: "less-important-data-that-is-also-longer" }),
        makeNode("low00002", { w: 0.12, val: "another-less-important-node-with-data" }),
      ];
      const input: FrameInput = { frame: makeFrame({ max_token_budget: 300 }), nodes, edges: [] };
      const resolved = resolveFrame(input);

      const result = serializeFrame(resolved, 1, { tier: "full", tokenizer });

      expect(result.tokens).toBeLessThanOrEqual(300);
      // High-weight node should survive pruning
      if (result.actualTier === "full") {
        const payload = result.payload as import("../../src/serializer/serializer.js").FullPayload;
        const nodeIds = payload.nodes.map((n) => n.id);
        expect(nodeIds).toContain("high0001");
      }
    });

    it("throws BudgetExceededError when even signal exceeds budget", () => {
      const nodes = [frameNode, ...Array.from({ length: 50 }, (_, i) =>
        makeNode(`n${String(i).padStart(7, "0")}`)
      )];
      const input: FrameInput = { frame: makeFrame({ max_token_budget: 5 }), nodes, edges: [] };
      const resolved = resolveFrame(input);

      expect(() =>
        serializeFrame(resolved, 1, { tier: "full", tokenizer })
      ).toThrow(BudgetExceededError);
    });
  });

  describe("estimateTokens", () => {
    it("returns token counts for all three tiers", () => {
      const input: FrameInput = {
        frame: makeFrame(),
        nodes: [frameNode, makeNode("a0000001"), makeNode("b0000001")],
        edges: [],
      };
      const resolved = resolveFrame(input);
      const estimates = estimateTokens(resolved, 1, tokenizer);

      expect(estimates.full).toBeGreaterThan(0);
      expect(estimates.condensed).toBeGreaterThan(0);
      expect(estimates.signal).toBeGreaterThan(0);
      // Signal is always smallest. Condensed without a previous full may
      // be LARGER than full (all nodes as "added" + wrapper overhead).
      // Full >= Signal is the universal invariant.
      expect(estimates.full).toBeGreaterThanOrEqual(estimates.signal);
    });
  });
});
