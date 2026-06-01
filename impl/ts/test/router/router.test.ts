import { describe, it, expect } from "vitest";
import { FrameRouter } from "../../src/router/router.js";
import { resolveFrame } from "../../src/resolver/resolver.js";
import type { FrameInput } from "../../src/resolver/resolver.js";
import type { CbpNode } from "../../src/types/node.js";
import { lengthFallbackTokenizer } from "../../src/tokenizer/length-fallback.js";

const tokenizer = lengthFallbackTokenizer;

const frameNode: CbpNode = {
  id: "f0000001",
  type: "frame",
  val: { name: "test" },
  w: 1.0,
  decay: "none",
  ttl: null,
  lineage: null,
  tags: ["domain:testing"],
  v: 1,
  prev: null,
};

const entityNode: CbpNode = {
  id: "a0000001",
  type: "entity",
  val: "TestEntity",
  w: 0.8,
  decay: "none",
  ttl: null,
  lineage: "f0000001",
  tags: [],
  v: 1,
  prev: null,
};

function makeInput(): FrameInput {
  return {
    frame: {
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
    },
    nodes: [frameNode, entityNode],
    edges: [],
  };
}

describe("FrameRouter", () => {
  describe("tier negotiation", () => {
    it("returns Full on first encounter with auto", () => {
      const router = new FrameRouter();
      const tier = router.negotiateTier("conv1", "test_frame", "auto");
      expect(tier).toBe("full");
    });

    it("returns the requested tier when not auto", () => {
      const router = new FrameRouter();
      expect(router.negotiateTier("conv1", "test_frame", "signal")).toBe("signal");
      expect(router.negotiateTier("conv1", "test_frame", "condensed")).toBe("condensed");
      expect(router.negotiateTier("conv1", "test_frame", "full")).toBe("full");
    });

    it("returns Condensed on second encounter with auto", () => {
      const router = new FrameRouter({ signalMinTurns: 3 });
      const resolved = resolveFrame(makeInput());

      // First delivery — full
      router.deliver("conv1", resolved, 1, "auto", tokenizer);

      // Second — should be condensed
      const tier = router.negotiateTier("conv1", "test_frame", "auto");
      expect(tier).toBe("condensed");
    });

    it("returns Signal after signalMinTurns with auto", () => {
      const router = new FrameRouter({ signalMinTurns: 2 });
      const resolved = resolveFrame(makeInput());

      // Deliver full, then 2 condensed turns
      router.deliver("conv1", resolved, 1, "auto", tokenizer);
      router.deliver("conv1", resolved, 2, "auto", tokenizer);
      router.deliver("conv1", resolved, 3, "auto", tokenizer);

      const tier = router.negotiateTier("conv1", "test_frame", "auto");
      expect(tier).toBe("signal");
    });
  });

  describe("deliver", () => {
    it("delivers full on first call and tracks state", () => {
      const router = new FrameRouter();
      const resolved = resolveFrame(makeInput());
      const result = router.deliver("conv1", resolved, 1, "auto", tokenizer);

      expect(result.actualTier).toBe("full");
      expect(result.tokens).toBeGreaterThan(0);

      const state = router.getState("conv1", "test_frame");
      expect(state.lastFull).not.toBeNull();
      expect(state.turnsSinceFull).toBe(0);
      expect(state.lastDeliveredVersion).toBe(1);
    });

    it("delivers condensed on second call with auto", () => {
      const router = new FrameRouter({ signalMinTurns: 5 });
      const resolved = resolveFrame(makeInput());

      router.deliver("conv1", resolved, 1, "auto", tokenizer);
      const result = router.deliver("conv1", resolved, 2, "auto", tokenizer);

      expect(result.actualTier).toBe("condensed");

      const state = router.getState("conv1", "test_frame");
      expect(state.turnsSinceFull).toBe(1);
    });

    it("isolates conversations from each other", () => {
      const router = new FrameRouter();
      const resolved = resolveFrame(makeInput());

      router.deliver("conv1", resolved, 1, "auto", tokenizer);
      // conv2 should still get full (first encounter for that conversation)
      const result = router.deliver("conv2", resolved, 1, "auto", tokenizer);
      expect(result.actualTier).toBe("full");
    });
  });

  describe("state management", () => {
    it("clears all conversations", () => {
      const router = new FrameRouter();
      const resolved = resolveFrame(makeInput());
      router.deliver("conv1", resolved, 1, "auto", tokenizer);

      router.clearAll();

      const tier = router.negotiateTier("conv1", "test_frame", "auto");
      expect(tier).toBe("full"); // back to first encounter
    });

    it("clears a specific conversation", () => {
      const router = new FrameRouter();
      const resolved = resolveFrame(makeInput());
      router.deliver("conv1", resolved, 1, "auto", tokenizer);
      router.deliver("conv2", resolved, 1, "auto", tokenizer);

      router.clearConversation("conv1");

      expect(router.negotiateTier("conv1", "test_frame", "auto")).toBe("full");
      expect(router.negotiateTier("conv2", "test_frame", "auto")).toBe("condensed");
    });
  });
});
