import { describe, it, expect } from "vitest";
import { InMemoryMemoryStore } from "../../src/memory/store.js";
import { getTokenizer } from "../../src/tokenizer/index.js";
import type { MemoryRecord } from "../../src/memory/types.js";

const tok = getTokenizer("length_fallback");
function rec(id: string): MemoryRecord {
  const full = "a recalled fact";
  return {
    id, nodeType: "state",
    fidelities: { full, condensed: full, signal: "s" },
    tokenCost: { full: tok.countTokens(full), condensed: tok.countTokens(full), signal: 1 },
    embedding: [0.1, 0.2], embeddingModel: "m", tags: ["x"], lineage: null, w: 1,
  };
}

describe("InMemoryMemoryStore immutability (no caller mutation aliasing)", () => {
  it("getById returns a copy; mutating it does not corrupt the store", async () => {
    const store = new InMemoryMemoryStore();
    await store.upsert(rec("a"));
    const got = await store.getById("a");
    got?.tags.push("evil");
    (got?.embedding as number[]).push(9);
    const again = await store.getById("a");
    expect(again?.tags).toEqual(["x"]);
    expect(again?.embedding).toEqual([0.1, 0.2]);
  });

  it("query returns copies too", async () => {
    const store = new InMemoryMemoryStore();
    await store.upsert(rec("a"));
    const hits = await store.query({ tags: ["x"], k: 5 });
    hits[0]?.rec.tags.push("evil");
    const again = await store.getById("a");
    expect(again?.tags).toEqual(["x"]);
  });

  it("mutating the upsert argument afterward does not affect the store", async () => {
    const store = new InMemoryMemoryStore();
    const input = rec("a");
    await store.upsert(input);
    input.tags.push("evil");
    const again = await store.getById("a");
    expect(again?.tags).toEqual(["x"]);
  });
});
