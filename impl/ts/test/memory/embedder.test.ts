import { describe, it, expect } from "vitest";
import { HashingEmbedder, cosine } from "../../src/memory/embedder.js";

describe("HashingEmbedder", () => {
  it("is deterministic and unit-norm", async () => {
    const e = new HashingEmbedder(64);
    const a = await e.embed("account usage");
    const b = await e.embed("account usage");
    expect(a).toEqual(b);
    const norm = Math.sqrt(a.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });
  it("scores related text higher than unrelated (bag-of-words overlap)", async () => {
    const e = new HashingEmbedder(256);
    const q = await e.embed("account usage rising");
    const near = await e.embed("account usage climbing");
    const far = await e.embed("clinical patient intake vitals");
    expect(cosine(q, near)).toBeGreaterThan(cosine(q, far));
  });
  it("exposes a pinned model id for provenance", () => {
    expect(new HashingEmbedder(64).modelId).toBe("hashing-v1@64");
  });
});

describe("cosine", () => {
  it("throws on a vector length mismatch instead of scoring a truncated prefix", () => {
    expect(() => cosine([1, 0, 0], [1, 0])).toThrow(RangeError);
  });
});
