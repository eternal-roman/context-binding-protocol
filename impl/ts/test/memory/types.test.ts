import { describe, it, expect } from "vitest";
import { MemoryRecord, Fidelity } from "../../src/memory/types.js";

describe("MemoryRecord projection schema", () => {
  it("accepts a well-formed projected record with per-fidelity cost", () => {
    const rec = {
      id: "a7c3f1e2",
      nodeType: "state" as const,
      fidelities: { full: "BTC price 68420 at 14:30Z", condensed: "BTC 68420", signal: "state:domain:trading" },
      tokenCost: { full: 9, condensed: 3, signal: 4 },
      embedding: [0.1, 0.2, 0.3],
      embeddingModel: "hashing-v1@64",
      tags: ["domain:trading"],
      lineage: "f0d2e8a1",
      w: 0.9,
    };
    const parsed = MemoryRecord.parse(rec);
    expect(parsed.tokenCost.signal).toBe(4);
    const fids: Fidelity[] = ["full", "condensed", "signal"];
    expect(fids).toContain("full");
  });

  it("rejects a record missing a fidelity cost", () => {
    expect(() =>
      MemoryRecord.parse({
        id: "a7c3f1e2", nodeType: "state",
        fidelities: { full: "x", condensed: "x", signal: "x" },
        tokenCost: { full: 9, condensed: 3 }, // missing signal
        embedding: null, embeddingModel: null, tags: [], lineage: null, w: 1,
      })
    ).toThrow();
  });

  it("rejects a record carrying temporal fields not yet in the projection", () => {
    // Guard the Phase-1 decision: temporal validity arrives in Phase 5. zod
    // strips unknown keys by default, so assert the parsed object has no such key.
    const parsed = MemoryRecord.parse({
      id: "a7c3f1e2", nodeType: "state",
      fidelities: { full: "x", condensed: "x", signal: "x" },
      tokenCost: { full: 1, condensed: 1, signal: 1 },
      embedding: null, embeddingModel: null, tags: [], lineage: null, w: 1,
      validAt: 123, // not part of the schema yet
    } as Record<string, unknown>);
    expect("validAt" in parsed).toBe(false);
  });
});
