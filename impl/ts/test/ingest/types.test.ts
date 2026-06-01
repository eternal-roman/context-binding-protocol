import { describe, it, expect } from "vitest";
import { Fact } from "../../src/ingest/types.js";

describe("Fact schema", () => {
  it("accepts a well-formed fact and applies defaults", () => {
    const f = Fact.parse({ type: "state", val: "BTC up" });
    expect(f).toMatchObject({ type: "state", val: "BTC up", tags: [], w: 0.6 });
  });
  it("rejects missing / undefined / null val", () => {
    expect(Fact.safeParse({ type: "state" }).success).toBe(false);
    expect(Fact.safeParse({ type: "state", val: undefined }).success).toBe(false);
    expect(Fact.safeParse({ type: "state", val: null }).success).toBe(false);
  });
  it("rejects an out-of-range w and a non-allowed type", () => {
    expect(Fact.safeParse({ type: "state", val: "x", w: 1.5 }).success).toBe(false);
    expect(Fact.safeParse({ type: "frame", val: "x" }).success).toBe(false);
  });
  it("accepts an object val", () => {
    const f = Fact.parse({ type: "state", val: { price: 100 } });
    expect(f.val).toEqual({ price: 100 });
  });
});
