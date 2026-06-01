import { describe, it, expect } from "vitest";
import { StreamManager } from "../../src/ws/stream.js";
import { FrameRouter } from "../../src/router/router.js";
import { resolveFrame } from "../../src/resolver/resolver.js";
import type { FrameInput } from "../../src/resolver/resolver.js";
import type { CbpNode } from "../../src/types/node.js";
import { lengthFallbackTokenizer } from "../../src/tokenizer/length-fallback.js";

const frameNode: CbpNode = {
  id: "f0000001", type: "frame", val: { name: "test" },
  w: 1.0, decay: "none", ttl: null, lineage: null,
  tags: ["domain:testing"], v: 1, prev: null,
};

const entityNode: CbpNode = {
  id: "a0000001", type: "entity", val: "TestEntity",
  w: 0.8, decay: "none", ttl: null, lineage: "f0000001",
  tags: [], v: 1, prev: null,
};

function makeInput(): FrameInput {
  return {
    frame: {
      id: "test_frame", domain_tags: ["testing"], root_weight: 1.0,
      root_decay: "none", refresh_policy: "on_demand", max_token_budget: 2000,
      inheritance_mode: "prototypal", conditional_edge_eval: "eager",
      tokenizer: "length_fallback", acl_tags: [],
    },
    nodes: [frameNode, entityNode],
    edges: [],
  };
}

describe("StreamManager", () => {
  it("subscribes and receives notifications", () => {
    const manager = new StreamManager();
    const router = new FrameRouter();
    const messages: string[] = [];

    manager.subscribe({
      conversationId: "conv1",
      frameId: "test_frame",
      preferredTier: "auto",
      send: (data) => messages.push(data),
      close: () => {},
    });

    const resolved = resolveFrame(makeInput());
    const results = manager.notify("test_frame", resolved, 1, router, lengthFallbackTokenizer);

    expect(results).toHaveLength(1);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toBeTruthy();
  });

  it("unsubscribes correctly", () => {
    const manager = new StreamManager();
    const router = new FrameRouter();
    const messages: string[] = [];

    const unsub = manager.subscribe({
      conversationId: "conv1",
      frameId: "test_frame",
      preferredTier: "auto",
      send: (data) => messages.push(data),
      close: () => {},
    });

    unsub();

    const resolved = resolveFrame(makeInput());
    const results = manager.notify("test_frame", resolved, 1, router, lengthFallbackTokenizer);

    expect(results).toHaveLength(0);
    expect(messages).toHaveLength(0);
  });

  it("tracks subscriber count", () => {
    const manager = new StreamManager();

    expect(manager.subscriberCount("test_frame")).toBe(0);

    const unsub = manager.subscribe({
      conversationId: "conv1", frameId: "test_frame",
      preferredTier: "auto", send: () => {}, close: () => {},
    });

    expect(manager.subscriberCount("test_frame")).toBe(1);

    unsub();
    expect(manager.subscriberCount("test_frame")).toBe(0);
  });

  it("notifies multiple subscribers independently", () => {
    const manager = new StreamManager();
    const router = new FrameRouter();
    const msgs1: string[] = [];
    const msgs2: string[] = [];

    manager.subscribe({
      conversationId: "conv1", frameId: "test_frame",
      preferredTier: "auto", send: (d) => msgs1.push(d), close: () => {},
    });
    manager.subscribe({
      conversationId: "conv2", frameId: "test_frame",
      preferredTier: "signal", send: (d) => msgs2.push(d), close: () => {},
    });

    const resolved = resolveFrame(makeInput());
    manager.notify("test_frame", resolved, 1, router, lengthFallbackTokenizer);

    expect(msgs1).toHaveLength(1);
    expect(msgs2).toHaveLength(1);
  });

  it("shutdown closes all subscriptions", () => {
    const manager = new StreamManager();
    let closed = 0;

    manager.subscribe({
      conversationId: "conv1", frameId: "test_frame",
      preferredTier: "auto", send: () => {}, close: () => { closed++; },
    });
    manager.subscribe({
      conversationId: "conv2", frameId: "other_frame",
      preferredTier: "auto", send: () => {}, close: () => { closed++; },
    });

    manager.shutdown();
    expect(closed).toBe(2);
  });

  describe("notifyEvent (v0.7)", () => {
    it("broadcasts a mutation event as JSON to all frame subscribers", () => {
      const manager = new StreamManager();
      const received: string[] = [];

      manager.subscribe({
        conversationId: "conv1",
        frameId: "test_frame",
        preferredTier: "auto",
        send: (d) => received.push(d),
        close: () => {},
      });
      manager.subscribe({
        conversationId: "conv2",
        frameId: "test_frame",
        preferredTier: "signal",
        send: (d) => received.push(d),
        close: () => {},
      });

      const delivered = manager.notifyEvent({
        event: "node_upserted",
        frame_id: "test_frame",
        node_id: "a7c3f1e2",
        v: 3,
      });

      expect(delivered).toBe(2);
      expect(received).toHaveLength(2);
      const first = received[0];
      if (first === undefined) throw new Error("expected at least one message");
      const parsed = JSON.parse(first) as {
        event: string;
        frame_id: string;
        node_id: string;
        v: number;
      };
      expect(parsed.event).toBe("node_upserted");
      expect(parsed.node_id).toBe("a7c3f1e2");
      expect(parsed.v).toBe(3);
    });

    it("returns 0 and sends nothing when no subscribers exist for the frame", () => {
      const manager = new StreamManager();
      const delivered = manager.notifyEvent({
        event: "node_upserted",
        frame_id: "unsubscribed_frame",
        node_id: "x",
        v: 1,
      });
      expect(delivered).toBe(0);
    });

    it("does not cross-broadcast between frames", () => {
      const manager = new StreamManager();
      const frameA: string[] = [];
      const frameB: string[] = [];

      manager.subscribe({
        conversationId: "c1",
        frameId: "frame_a",
        preferredTier: "auto",
        send: (d) => frameA.push(d),
        close: () => {},
      });
      manager.subscribe({
        conversationId: "c2",
        frameId: "frame_b",
        preferredTier: "auto",
        send: (d) => frameB.push(d),
        close: () => {},
      });

      manager.notifyEvent({
        event: "import_committed",
        frame_id: "frame_a",
        nodes: 5,
        edges: 2,
      });

      expect(frameA).toHaveLength(1);
      expect(frameB).toHaveLength(0);
    });
  });
});
