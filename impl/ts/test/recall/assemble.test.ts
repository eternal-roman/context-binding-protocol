import { describe, it, expect } from "vitest";
import { assembleContext } from "../../src/recall/assemble.js";
import { getTokenizer } from "../../src/tokenizer/index.js";
import type { MemoryRecord } from "../../src/memory/types.js";

const tok = getTokenizer("length_fallback"); // deterministic

function rec(id: string, over: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id, nodeType: "state",
    fidelities: { full: "F".repeat(40), condensed: "C".repeat(12), signal: "s" },
    tokenCost: { full: tok.countTokens("F".repeat(40)), condensed: tok.countTokens("C".repeat(12)), signal: tok.countTokens("s") },
    embedding: null, embeddingModel: null, tags: [], lineage: null, w: 1, ...over,
  };
}
const ranked = (recs: Array<[MemoryRecord, number]>): Array<{ rec: MemoryRecord; score: number }> =>
  recs.map(([r, s]) => ({ rec: r, score: s }));

describe("assembleContext", () => {
  it("never exceeds budget and reports tokensUsed on the rendered block", () => {
    const out = assembleContext(ranked([[rec("aaaaaaaa"), 0.9], [rec("bbbbbbbb"), 0.8]]), { budget: 1000, tokenizer: tok });
    expect(out.tokensUsed).toBe(tok.countTokens(out.block));
    expect(out.tokensUsed).toBeLessThanOrEqual(1000);
  });
  it("degrades fidelity to fit: a record that cannot fit at full is admitted condensed", () => {
    const small = tok.countTokens("── Recalled context ──\n\n[1] (state) " + "C".repeat(12)) + 2;
    const out = assembleContext(ranked([[rec("aaaaaaaa"), 0.9]]), { budget: small, tokenizer: tok });
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0]?.fidelity).toBe("condensed");
    expect(out.tokensUsed).toBeLessThanOrEqual(small);
  });
  it("preserves caller input order with stable 1-based refs", () => {
    const out = assembleContext(ranked([[rec("bbbbbbbb"), 0.5], [rec("aaaaaaaa"), 0.9]]), { budget: 1000, tokenizer: tok });
    expect(out.entries.map((e) => e.id)).toEqual(["bbbbbbbb", "aaaaaaaa"]); // assembler preserves caller order
    expect(out.entries.map((e) => e.ref)).toEqual([1, 2]);
  });
  it("drops below minScore with reason min_score", () => {
    const out = assembleContext(ranked([[rec("aaaaaaaa"), 0.9], [rec("bbbbbbbb"), 0.1]]), { budget: 1000, tokenizer: tok, minScore: 0.5 });
    expect(out.entries.map((e) => e.id)).toEqual(["aaaaaaaa"]);
    expect(out.dropped).toContainEqual({ id: "bbbbbbbb", reason: "min_score" });
  });
  it("when nothing fits, returns an empty block (0 tokens) and drops with no_fidelity_fits", () => {
    const out = assembleContext(ranked([[rec("aaaaaaaa"), 0.9]]), { budget: 1, tokenizer: tok });
    expect(out.entries).toHaveLength(0);
    expect(out.block).toBe("");
    expect(out.tokensUsed).toBe(0);
    expect(out.dropped).toContainEqual({ id: "aaaaaaaa", reason: "no_fidelity_fits" });
  });
  it("empty input yields an empty block", () => {
    const out = assembleContext([], { budget: 1000, tokenizer: tok });
    expect(out).toMatchObject({ block: "", tokensUsed: 0, entries: [], dropped: [] });
  });
});
