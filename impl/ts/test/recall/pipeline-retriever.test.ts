import { describe, it, expect } from "vitest";
import { GraphStore } from "../../src/graph/store.js";
import { InMemoryMemoryStore } from "../../src/memory/store.js";
import { HashingEmbedder } from "../../src/memory/embedder.js";
import { MemoryIngestor } from "../../src/ingest/ingest.js";
import { HeuristicEntityTagger } from "../../src/ingest/entity-tagger.js";
import { EntityIndex } from "../../src/memory/entity-index.js";
import { GraphExpansionRetriever } from "../../src/recall/retriever.js";
import { RecallPipeline } from "../../src/recall/pipeline.js";
import { getTokenizer } from "../../src/tokenizer/index.js";
import type { Tokenizer } from "../../src/tokenizer/tokenizer.js";

const FACTS: unknown[] = [
  { type: "state", val: "Alice Chen is the CTO of Nimbus Robotics.", tags: [], w: 0.6 },
  { type: "state", val: "Nimbus Robotics is headquartered in Dresden.", tags: [], w: 0.6 },
  { type: "state", val: "Dresden is located in the region of Saxony.", tags: [], w: 0.6 },
];
const Q2 = "In which city is the headquarters of the company that Alice Chen works for?";

async function build(withRetriever: boolean): Promise<{ pipeline: RecallPipeline; tok: Tokenizer }> {
  const tok = getTokenizer("o200k_base");
  const graph = new GraphStore({ maxNodesPerFrame: 1000 });
  const memory = new InMemoryMemoryStore();
  const embedder = new HashingEmbedder(64);
  const index = new EntityIndex();
  await new MemoryIngestor({ graph, memory, embedder, entityTagger: new HeuristicEntityTagger(), entityIndex: index }).ingestFacts("probe", FACTS, tok);
  const retriever = withRetriever ? new GraphExpansionRetriever({ embedder, memory, entityIndex: index, tagger: new HeuristicEntityTagger() }) : undefined;
  return { pipeline: new RecallPipeline({ embedder, memory, retriever }), tok };
}

describe("RecallPipeline with GraphExpansionRetriever", () => {
  it("delivers the bridge fact into the assembled context for a 2-hop query", async () => {
    const { pipeline, tok } = await build(true);
    const ctx = await pipeline.recall(Q2, { scopeTags: ["frame:probe"], budget: 4000, tokenizer: tok, k: 1 });
    expect(ctx.block).toContain("Dresden");
  });

  it("dense-only path (no retriever) misses the bridge — confirms the lift is the retriever", async () => {
    const { pipeline, tok } = await build(false);
    // HashingEmbedder ranks the Alice/Nimbus role fact above the Dresden HQ fact for
    // this query, so k:1 dense retrieval returns only the role fact — the HQ bridge is
    // unreachable without graph expansion.
    const ctx = await pipeline.recall(Q2, { scopeTags: ["frame:probe"], budget: 4000, tokenizer: tok, k: 1 });
    expect(ctx.block).not.toContain("headquartered in Dresden");
  });

  it("1-hop NON-REGRESSION: the answer fact survives expansion (CI gate)", async () => {
    const { pipeline, tok } = await build(true);
    const ctx = await pipeline.recall("What position does Alice Chen hold at Nimbus Robotics?", { scopeTags: ["frame:probe"], budget: 4000, tokenizer: tok });
    expect(ctx.block).toContain("CTO");
  });

  it("1-hop NON-REGRESSION under TIGHT budget: the answer seed is not crowded out by bridges", async () => {
    const { pipeline, tok } = await build(true);
    const ctx = await pipeline.recall("What position does Alice Chen hold at Nimbus Robotics?", { scopeTags: ["frame:probe"], budget: 40, tokenizer: tok });
    expect(ctx.block).toContain("CTO");
  });
});
