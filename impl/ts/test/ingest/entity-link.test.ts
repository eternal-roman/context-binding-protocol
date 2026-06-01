import { describe, it, expect } from "vitest";
import { GraphStore } from "../../src/graph/store.js";
import { InMemoryMemoryStore } from "../../src/memory/store.js";
import { HashingEmbedder } from "../../src/memory/embedder.js";
import { MemoryIngestor } from "../../src/ingest/ingest.js";
import { HeuristicEntityTagger } from "../../src/ingest/entity-tagger.js";
import { EntityIndex } from "../../src/memory/entity-index.js";
import { getTokenizer } from "../../src/tokenizer/index.js";

const FACTS: unknown[] = [
  { type: "state", val: "Alice Chen is the CTO of Nimbus Robotics.", tags: [], w: 0.6 },
  { type: "state", val: "Nimbus Robotics is headquartered in Dresden.", tags: [], w: 0.6 },
  { type: "state", val: "Dresden is located in the region of Saxony.", tags: [], w: 0.6 },
];

function ingestor(withTagger: boolean): { run: MemoryIngestor; index: EntityIndex } {
  const index = new EntityIndex();
  const run = new MemoryIngestor({
    graph: new GraphStore({ maxNodesPerFrame: 1000 }),
    memory: new InMemoryMemoryStore(),
    embedder: new HashingEmbedder(64),
    ...(withTagger ? { entityTagger: new HeuristicEntityTagger(), entityIndex: index } : {}),
  });
  return { run, index };
}

describe("entity-link integration (3B-G1)", () => {
  it("links facts that share an entity via the overlay index", async () => {
    const tok = getTokenizer("o200k_base");
    const { run, index } = ingestor(true);
    const res = await run.ingestFacts("probe", FACTS, tok);
    const [roleId, hqId, regionId] = res.nodeIds;
    // company links role+hq; city links hq+region — the bridges traversal needs.
    expect(index.lookup("nimbus-robotics").sort()).toEqual([hqId, roleId].sort());
    expect(index.lookup("dresden").sort()).toEqual([hqId, regionId].sort());
  });

  it("does NOT change node identity (entity tags are an overlay, not content)", async () => {
    const tok = getTokenizer("o200k_base");
    const without = await ingestor(false).run.ingestFacts("probe", FACTS, tok);
    const withTag = await ingestor(true).run.ingestFacts("probe", FACTS, tok);
    expect(withTag.nodeIds).toEqual(without.nodeIds); // identical BLAKE3 ids ⇒ tagging never touched content
  });

  it("treats the entity overlay as best-effort — a tagger throw does not skip the committed node", async () => {
    const tok = getTokenizer("o200k_base");
    const throwingTagger = { tag(): string[] { throw new Error("boom"); } };
    const run = new MemoryIngestor({
      graph: new GraphStore({ maxNodesPerFrame: 1000 }),
      memory: new InMemoryMemoryStore(),
      embedder: new HashingEmbedder(64),
      entityTagger: throwingTagger,
      entityIndex: new EntityIndex(),
    });
    const res = await run.ingestFacts("probe", FACTS, tok);
    expect(res.ingested).toBe(3);
    expect(res.skipped).toEqual([]);
    expect(res.nodeIds).toHaveLength(3);
  });

  it("rejects a half-installed entity overlay (only one of tagger/index)", () => {
    expect(
      () =>
        new MemoryIngestor({
          graph: new GraphStore({ maxNodesPerFrame: 1000 }),
          memory: new InMemoryMemoryStore(),
          embedder: new HashingEmbedder(64),
          entityIndex: new EntityIndex(),
        }),
    ).toThrow(/together or not at all/);
  });
});
