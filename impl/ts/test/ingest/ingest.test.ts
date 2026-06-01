import { describe, it, expect } from "vitest";
import { MemoryIngestor } from "../../src/ingest/ingest.js";
import { GraphStore } from "../../src/graph/store.js";
import { InMemoryMemoryStore } from "../../src/memory/store.js";
import { HashingEmbedder } from "../../src/memory/embedder.js";
import { getTokenizer } from "../../src/tokenizer/index.js";
import { LlmExtractor } from "../../src/ingest/extract.js";
import type { LlmClient } from "../../src/recall/llm.js";

const tok = getTokenizer("length_fallback");
function newIngestor(): { graph: GraphStore; memory: InMemoryMemoryStore; ingestor: MemoryIngestor } {
  const graph = new GraphStore({ maxNodesPerFrame: 5000 });
  const memory = new InMemoryMemoryStore();
  const embedder = new HashingEmbedder(64);
  return { graph, memory, ingestor: new MemoryIngestor({ graph, memory, embedder }) };
}

describe("MemoryIngestor.ingestFacts", () => {
  it("writes the graph node AND a projected memory record tagged frame:<id>", async () => {
    const { memory, ingestor } = newIngestor();
    const r = await ingestor.ingestFacts("trade", [{ type: "state", val: "BTC up", tags: ["live"], w: 0.9 }], tok);
    expect(r.ingested).toBe(1);
    expect(r.nodeIds).toHaveLength(1);
    const nodeId = r.nodeIds[0];
    if (!nodeId) throw new Error("no node id");
    const rec = await memory.getById(nodeId);
    expect(rec?.tags).toContain("frame:trade");
    expect(rec?.tags).toContain("live");
    expect(rec?.embedding).toHaveLength(64);
  });
  it("is idempotent on the frame anchor and dedups exact-duplicate facts (content-addressed)", async () => {
    const { ingestor } = newIngestor();
    const a = await ingestor.ingestFacts("trade", [{ type: "state", val: "same fact" }], tok);
    const b = await ingestor.ingestFacts("trade", [{ type: "state", val: "same fact" }], tok);
    expect(b.nodeIds[0]).toBe(a.nodeIds[0]); // identical content → identical id, reused not duplicated
  });
  it("does not create a second graph node for a duplicate fact", async () => {
    const { graph, ingestor } = newIngestor();
    await ingestor.ingestFacts("trade", [{ type: "state", val: "same fact" }], tok);
    const before = graph.getAllNodes().length;
    await ingestor.ingestFacts("trade", [{ type: "state", val: "same fact" }], tok);
    expect(graph.getAllNodes().length).toBe(before); // no new node; anchor + 1 fact only
  });
  it("ignores a client-supplied frame: tag (server owns the partition)", async () => {
    const { memory, ingestor } = newIngestor();
    const r = await ingestor.ingestFacts("trade", [{ type: "state", val: "x", tags: ["frame:evil", "ok"] }], tok);
    const nodeId = r.nodeIds[0];
    if (!nodeId) throw new Error("no node id");
    const rec = await memory.getById(nodeId);
    expect(rec?.tags).toContain("frame:trade");
    expect(rec?.tags).not.toContain("frame:evil");
    expect(rec?.tags).toContain("ok");
  });
  it("routes invalid facts to skipped without aborting valid ones", async () => {
    const { ingestor } = newIngestor();
    const r = await ingestor.ingestFacts("trade", [
      { type: "state", val: "good" },
      { type: "bogus" as unknown as "state", val: "bad" },
    ], tok);
    expect(r.ingested).toBe(1);
    expect(r.skipped).toHaveLength(1);
    const skipped = r.skipped[0];
    if (!skipped) throw new Error("no skipped entry");
    expect(skipped.index).toBe(1);
  });
  it("stores two distinct facts and makes both retrievable (loop accumulation)", async () => {
    const { memory, ingestor } = newIngestor();
    const r = await ingestor.ingestFacts("trade", [
      { type: "state", val: "alpha fact" },
      { type: "prior", val: "beta rule" },
    ], tok);
    expect(r.ingested).toBe(2);
    expect(new Set(r.nodeIds).size).toBe(2); // two distinct ids
    const [id0, id1] = r.nodeIds;
    if (!id0 || !id1) throw new Error("expected two node ids");
    expect(await memory.getById(id0)).toBeDefined();
    expect(await memory.getById(id1)).toBeDefined();
  });
  it("does NOT project the frame anchor into the memory index", async () => {
    const { memory, ingestor } = newIngestor();
    await ingestor.ingestFacts("trade", [{ type: "state", val: "only fact" }], tok);
    const all = await memory.query({}); // returns all stored records
    expect(all).toHaveLength(1); // just the fact — the frame anchor is structural, not a memory
  });
});

class CannedLlm implements LlmClient {
  readonly modelId = "canned";
  async complete(): Promise<{ text: string }> {
    return { text: '[{"type":"prior","val":"Do not deploy Fridays","tags":["policy"]}]' };
  }
}

describe("MemoryIngestor.ingestDocument", () => {
  it("extracts facts via the Extractor then ingests them (graph + memory)", async () => {
    const { memory, ingestor } = newIngestor();
    const r = await ingestor.ingestDocument("ops", "Some doc about deploys.", new LlmExtractor(new CannedLlm()), tok);
    expect(r.ingested).toBe(1);
    expect(r.extract?.facts).toBe(1);
    const id0 = r.nodeIds[0];
    if (!id0) throw new Error("expected a node id");
    const rec = await memory.getById(id0);
    expect(rec?.tags).toContain("frame:ops");
    expect(rec?.fidelities.full).toBe("Do not deploy Fridays");
  });
});
