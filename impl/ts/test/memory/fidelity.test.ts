import { describe, it, expect } from "vitest";
import { DeterministicFidelityDeriver, costOf } from "../../src/memory/fidelity.js";
import { getTokenizer } from "../../src/tokenizer/index.js";
import type { ResolvedNode } from "../../src/types/node.js";

const node = (over: Partial<ResolvedNode> = {}): ResolvedNode => ({
  id: "a7c3f1e2", type: "state", val: "x", lineage: null, tags: ["domain:trading"],
  v: 1, prev: null, w: 1, decay: "none", ttl: null, ...over,
});

describe("DeterministicFidelityDeriver", () => {
  it("is deterministic for the same node", () => {
    const d = new DeterministicFidelityDeriver();
    expect(d.derive(node({ val: "hello world" }))).toEqual(d.derive(node({ val: "hello world" })));
  });
  it("uses the raw string for Full, a type:tag fingerprint for Signal", () => {
    const f = new DeterministicFidelityDeriver().derive(node({ val: "BTC up" }));
    expect(f.full).toBe("BTC up");
    expect(f.signal).toBe("state:domain:trading");
  });
  it("condenses long content below full and emits ascending token cost", () => {
    const long = "sentence one is here. " + "filler ".repeat(80) + "tail.";
    const f = new DeterministicFidelityDeriver(120).derive(node({ val: long }));
    expect(f.condensed.length).toBeLessThan(f.full.length);
    const cost = costOf(f, getTokenizer("length_fallback"));
    expect(cost.full).toBeGreaterThanOrEqual(cost.condensed);
    expect(cost.condensed).toBeGreaterThanOrEqual(cost.signal);
  });
  it("canonicalizes non-string val for Full (stable object encoding)", () => {
    const f = new DeterministicFidelityDeriver().derive(node({ val: { b: 2, a: 1 } }));
    // canonical JSON sorts keys, so this is stable regardless of insertion order
    expect(f.full).toBe('{"a":1,"b":2}');
  });
  it("condense keeps a clean sentence boundary that falls past the window midpoint (A18)", () => {
    // A '. ' at index 70 (> 120 * 0.5) — the keep-clean-sentence branch must fire,
    // cutting at the sentence end rather than a hard trim.
    const long = "x".repeat(70) + ". " + "y".repeat(80);
    const f = new DeterministicFidelityDeriver(120).derive(node({ val: long }));
    expect(f.condensed).toBe("x".repeat(70) + ".…");
    expect(f.condensed.length).toBeLessThan(f.full.length);
  });
});
