/**
 * S3 — conversation state must be bounded (LRU eviction).
 *
 * `FrameRouter.conversations` is keyed by the client-supplied
 * `X-CBP-Conversation` header and retains a full payload (`lastFull`) per
 * (conversation, frame). With no eviction, a client cycling unique
 * conversation ids grows the map without bound → OOM. The fix caps the
 * number of tracked conversations and evicts the least-recently-used one
 * when the cap is exceeded.
 *
 * @see cbp-architecture.html Section IV — Tier Negotiation Flow
 */

import { describe, it, expect } from "vitest";
import { FrameRouter } from "../../src/router/router.js";

describe("FrameRouter conversation eviction (S3)", () => {
  it("evicts the least-recently-used conversation past the cap", () => {
    const router = new FrameRouter({ maxConversations: 3 });
    router.getState("a", "f");
    router.getState("b", "f");
    router.getState("c", "f");
    expect(router.conversationCount).toBe(3);

    // Touch "a" so it becomes most-recently-used; "b" is now the LRU.
    router.getState("a", "f");

    // Inserting a 4th conversation must evict the LRU ("b"), not "a".
    router.getState("d", "f");
    expect(router.conversationCount).toBe(3);
    expect(router.hasConversation("b")).toBe(false);
    expect(router.hasConversation("a")).toBe(true);
    expect(router.hasConversation("c")).toBe(true);
    expect(router.hasConversation("d")).toBe(true);
  });

  it("stays bounded under a flood of unique conversation ids", () => {
    const router = new FrameRouter({ maxConversations: 10 });
    for (let i = 0; i < 1000; i++) {
      router.getState(`conv-${i}`, "f");
    }
    expect(router.conversationCount).toBe(10);
    // Only the most-recent 10 survive.
    expect(router.hasConversation("conv-999")).toBe(true);
    expect(router.hasConversation("conv-0")).toBe(false);
  });

  it("does not evict below the cap", () => {
    const router = new FrameRouter({ maxConversations: 10000 });
    for (let i = 0; i < 50; i++) {
      router.getState(`conv-${i}`, "f");
    }
    expect(router.conversationCount).toBe(50);
  });

  it("re-accessing an existing conversation does not grow the count", () => {
    const router = new FrameRouter({ maxConversations: 5 });
    router.getState("x", "f1");
    router.getState("x", "f2");
    router.getState("x", "f1");
    expect(router.conversationCount).toBe(1);
  });
});
