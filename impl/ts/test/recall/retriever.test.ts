import { describe, it, expect } from "vitest";
import { GraphStore } from "../../src/graph/store.js";
import { InMemoryMemoryStore } from "../../src/memory/store.js";
import { HashingEmbedder } from "../../src/memory/embedder.js";
import { MemoryIngestor } from "../../src/ingest/ingest.js";
import { HeuristicEntityTagger } from "../../src/ingest/entity-tagger.js";
import { EntityIndex } from "../../src/memory/entity-index.js";
import { GraphExpansionRetriever } from "../../src/recall/retriever.js";
import { getTokenizer } from "../../src/tokenizer/index.js";
import type { Embedder } from "../../src/memory/embedder.js";
import type { IngestResult } from "../../src/ingest/types.js";

const FACTS: unknown[] = [
  { type: "state", val: "Alice Chen is the CTO of Nimbus Robotics.", tags: [], w: 0.6 },
  { type: "state", val: "Nimbus Robotics is headquartered in Dresden.", tags: [], w: 0.6 },
  { type: "state", val: "Dresden is located in the region of Saxony.", tags: [], w: 0.6 },
];

async function setup(frame = "probe"): Promise<{
  retriever: GraphExpansionRetriever; res: IngestResult; memory: InMemoryMemoryStore; index: EntityIndex; embedder: HashingEmbedder;
}> {
  const tok = getTokenizer("o200k_base");
  const graph = new GraphStore({ maxNodesPerFrame: 1000 });
  const memory = new InMemoryMemoryStore();
  const embedder = new HashingEmbedder(64);
  const index = new EntityIndex();
  const res = await new MemoryIngestor({ graph, memory, embedder, entityTagger: new HeuristicEntityTagger(), entityIndex: index })
    .ingestFacts(frame, FACTS, tok);
  const retriever = new GraphExpansionRetriever({ embedder, memory, entityIndex: index, tagger: new HeuristicEntityTagger() });
  return { retriever, res, memory, index, embedder };
}

describe("GraphExpansionRetriever — seeding", () => {
  it("surfaces a query-named entity's fact as a hop-0 seed", async () => {
    const { retriever, res } = await setup();
    const [roleId] = res.nodeIds;
    const scored = await retriever.retrieve("What is the role of Alice Chen?", { scopeTags: ["frame:probe"], maxHops: 0 });
    const seed = scored.find((s) => s.rec.id === roleId);
    expect(seed).toBeDefined();
    expect(seed?.hop).toBe(0);
  });

  it("honors the scope partition — never returns facts outside scopeTags", async () => {
    const { retriever } = await setup();
    expect(await retriever.retrieve("Alice Chen", { scopeTags: ["frame:other"], maxHops: 0 })).toEqual([]);
  });

  it("falls back to dense results when the query names no extractable entity", async () => {
    const { retriever } = await setup();
    const scored = await retriever.retrieve("recent updates summary please", { scopeTags: ["frame:probe"], maxHops: 0 });
    expect(scored.length).toBeGreaterThan(0);
    expect(scored.every((s) => s.rec.tags.includes("frame:probe"))).toBe(true);
  });

  it("uses embedQuery when the embedder provides it", async () => {
    const { memory, index } = await setup("eq");
    let usedEmbedQuery = false;
    const base = new HashingEmbedder(64);
    const asymmetric: Embedder = {
      modelId: base.modelId, dim: base.dim,
      embed: (t) => base.embed(t),
      embedQuery: (t) => { usedEmbedQuery = true; return base.embed(t); },
    };
    const r = new GraphExpansionRetriever({ embedder: asymmetric, memory, entityIndex: index, tagger: new HeuristicEntityTagger() });
    await r.retrieve("Alice Chen", { scopeTags: ["frame:eq"], maxHops: 0 });
    expect(usedEmbedQuery).toBe(true);
  });
});

describe("GraphExpansionRetriever — expansion", () => {
  it("gathers the 2-hop bridge a one-entity query cannot match directly", async () => {
    const { retriever, res } = await setup();
    const [roleId, hqId, regionId] = res.nodeIds as [string, string, string];
    const scored = await retriever.retrieve(
      "In which city is the headquarters of the company that Alice Chen works for?",
      { scopeTags: ["frame:probe"], k: 1, maxHops: 2 },
    );
    const byId = new Map(scored.map((s) => [s.rec.id, s]));
    expect(byId.has(roleId)).toBe(true);
    expect(byId.get(hqId)?.hop).toBe(1);
    expect(byId.has(regionId)).toBe(true);
    expect(byId.get(regionId)?.hop).toBe(2); // 2-hop reach, explicit hop assertion
  });

  it("bounds per-node expansion at frontierCap (cap actually fires)", async () => {
    const tok = getTokenizer("o200k_base");
    const graph = new GraphStore({ maxNodesPerFrame: 1000 });
    const memory = new InMemoryMemoryStore();
    const embedder = new HashingEmbedder(64);
    const index = new EntityIndex();
    const facts: unknown[] = [
      { type: "state", val: "Alice Reed manages Hubcorp.", tags: [], w: 0.6 },
      ...Array.from({ length: 6 }, (_, i) => ({ type: "state", val: `Hubcorp metric ${i} reads value ${i}.`, tags: [], w: 0.6 })),
    ];
    await new MemoryIngestor({ graph, memory, embedder, entityTagger: new HeuristicEntityTagger(), entityIndex: index }).ingestFacts("cap", facts, tok);
    const retriever = new GraphExpansionRetriever({ embedder, memory, entityIndex: index, tagger: new HeuristicEntityTagger() });
    const scored = await retriever.retrieve("Alice Reed", { scopeTags: ["frame:cap"], k: 1, maxHops: 1, frontierCap: 2 });
    expect(scored.length).toBeLessThanOrEqual(3);
    expect(scored.length).toBeGreaterThanOrEqual(2);
  });

  it("is deterministic across runs on tied bridge scores", async () => {
    const { retriever } = await setup();
    const q = "In which region is the headquarters city of Alice Chen's company located?";
    const a = await retriever.retrieve(q, { scopeTags: ["frame:probe"], k: 1, maxHops: 2 });
    const b = await retriever.retrieve(q, { scopeTags: ["frame:probe"], k: 1, maxHops: 2 });
    expect(a.map((s) => s.rec.id)).toEqual(b.map((s) => s.rec.id));
  });

  it("known limitation (deferred to G3a): a surface-form alias mismatch leaves the bridge unreachable", async () => {
    const tok = getTokenizer("o200k_base");
    const graph = new GraphStore({ maxNodesPerFrame: 1000 });
    const memory = new InMemoryMemoryStore();
    const embedder = new HashingEmbedder(64);
    const index = new EntityIndex();
    const facts: unknown[] = [
      { type: "state", val: "Bret Lyle leads Nimbus.", tags: [], w: 0.6 },
      { type: "state", val: "Nimbus Robotics is based in Dresden.", tags: [], w: 0.6 },
    ];
    const res = await new MemoryIngestor({ graph, memory, embedder, entityTagger: new HeuristicEntityTagger(), entityIndex: index }).ingestFacts("alias", facts, tok);
    const retriever = new GraphExpansionRetriever({ embedder, memory, entityIndex: index, tagger: new HeuristicEntityTagger() });
    const scored = await retriever.retrieve("Where is the company Bret Lyle leads based?", { scopeTags: ["frame:alias"], k: 1, maxHops: 2 });
    const hqId = res.nodeIds[1];
    expect(scored.find((s) => s.rec.id === hqId)).toBeUndefined();
  });
});
