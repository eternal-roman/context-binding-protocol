import { describe, it, expect } from "vitest";
import { InMemoryMemoryStore } from "../../src/memory/store.js";
import { HashingEmbedder } from "../../src/memory/embedder.js";
import type { MemoryRecord } from "../../src/memory/types.js";

function rec(id: string, over: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id, nodeType: "state",
    fidelities: { full: "f", condensed: "c", signal: "s" },
    tokenCost: { full: 9, condensed: 3, signal: 2 },
    embedding: null, embeddingModel: null, tags: [], lineage: null, w: 1, ...over,
  };
}

describe("InMemoryMemoryStore basics", () => {
  it("upserts and reads back by id", async () => {
    const s = new InMemoryMemoryStore();
    await s.upsert(rec("a7c3f1e2"));
    expect((await s.getById("a7c3f1e2"))?.id).toBe("a7c3f1e2");
    expect(await s.getById("deadbeef")).toBeUndefined();
  });
  it("delete removes a record", async () => {
    const s = new InMemoryMemoryStore();
    await s.upsert(rec("a7c3f1e2"));
    expect(await s.delete("a7c3f1e2")).toBe(true);
    expect(await s.getById("a7c3f1e2")).toBeUndefined();
  });
  it("upsert overwrites an existing id (idempotent replace, not a duplicate)", async () => {
    const s = new InMemoryMemoryStore();
    await s.upsert(rec("a7c3f1e2", { w: 0.2 }));
    await s.upsert(rec("a7c3f1e2", { w: 0.9, tags: ["updated"] }));
    const got = await s.getById("a7c3f1e2");
    expect(got?.w).toBe(0.9);
    expect(got?.tags).toEqual(["updated"]);
    expect(await s.query({})).toHaveLength(1);
  });
  it("delete of an absent id returns false", async () => {
    const s = new InMemoryMemoryStore();
    expect(await s.delete("deadbeef")).toBe(false);
  });
});

describe("InMemoryMemoryStore.query", () => {
  it("ranks by cosine to the query embedding and respects k", async () => {
    const e = new HashingEmbedder(256);
    const s = new InMemoryMemoryStore();
    await s.upsert(rec("aaaaaaaa", { embedding: await e.embed("account usage climbing") }));
    await s.upsert(rec("bbbbbbbb", { embedding: await e.embed("patient blood pressure vitals") }));
    const out = await s.query({ embedding: await e.embed("account usage rising"), k: 1 });
    expect(out).toHaveLength(1);
    expect(out[0]?.rec.id).toBe("aaaaaaaa");
  });
  it("filters by tag (AND)", async () => {
    const s = new InMemoryMemoryStore();
    await s.upsert(rec("aaaaaaaa", { tags: ["domain:accounts", "live"] }));
    await s.upsert(rec("bbbbbbbb", { tags: ["domain:clinical", "live"] }));
    const out = await s.query({ tags: ["domain:accounts"] });
    expect(out.map((r) => r.rec.id)).toEqual(["aaaaaaaa"]);
    const both = await s.query({ tags: ["domain:accounts", "live"] });
    expect(both.map((r) => r.rec.id)).toEqual(["aaaaaaaa"]);
    const none = await s.query({ tags: ["domain:accounts", "missing"] });
    expect(none).toHaveLength(0);
  });
  it("falls back to structural weight ordering when no query vector is given", async () => {
    const s = new InMemoryMemoryStore();
    await s.upsert(rec("aaaaaaaa", { w: 0.2 }));
    await s.upsert(rec("bbbbbbbb", { w: 0.9 }));
    const out = await s.query({});
    expect(out.map((r) => r.rec.id)).toEqual(["bbbbbbbb", "aaaaaaaa"]);
  });
  it("scores an unembedded record 0 under a vector query (no weight leak)", async () => {
    const e = new HashingEmbedder(64);
    const s = new InMemoryMemoryStore();
    await s.upsert(rec("aaaaaaaa", { embedding: await e.embed("alpha beta"), w: 0.1 }));
    await s.upsert(rec("bbbbbbbb", { embedding: null, w: 0.99 })); // high weight, no embedding
    const out = await s.query({ embedding: await e.embed("alpha beta") });
    expect(out.find((r) => r.rec.id === "bbbbbbbb")?.score).toBe(0);
    expect(out[0]?.rec.id).toBe("aaaaaaaa"); // embedded match beats high-weight unembedded
  });
  it("throws on an embedding dimension mismatch (mixed embedders)", async () => {
    const s = new InMemoryMemoryStore();
    await s.upsert(rec("aaaaaaaa", { embedding: [0, 1, 0, 0] })); // dim 4
    await expect(s.query({ embedding: [1, 0] })).rejects.toThrow(/dim mismatch/i);
  });
});
