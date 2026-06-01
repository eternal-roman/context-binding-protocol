import { describe, it, expect } from "vitest";
import { MemoryIngestor } from "../../src/ingest/ingest.js";
import { GraphStore, MaxNodesExceededError } from "../../src/graph/store.js";
import { InMemoryMemoryStore } from "../../src/memory/store.js";
import { HashingEmbedder } from "../../src/memory/embedder.js";
import { getTokenizer } from "../../src/tokenizer/index.js";

const tok = getTokenizer("length_fallback");
function newIngestor(maxNodes = 5000): { graph: GraphStore; ingestor: MemoryIngestor } {
  const graph = new GraphStore({ maxNodesPerFrame: maxNodes });
  return { graph, ingestor: new MemoryIngestor({ graph, memory: new InMemoryMemoryStore(), embedder: new HashingEmbedder(64) }) };
}

describe("MemoryIngestor resilience", () => {
  it("routes a too-deeply-nested fact val to skipped[] WITHOUT aborting the batch", async () => {
    const { ingestor } = newIngestor();
    // canonicalize depth limit is 64; nest deeper so deriveId throws CanonicalizeError.
    let deep: unknown = "x";
    for (let i = 0; i < 100; i++) deep = { a: deep };
    const r = await ingestor.ingestFacts(
      "f",
      [{ type: "state", val: "good one" }, { type: "state", val: deep }, { type: "state", val: "good two" }],
      tok,
    );
    expect(r.ingested).toBe(2);            // both good facts survive
    expect(r.skipped).toHaveLength(1);     // the deep one is skipped, not fatal
    expect(r.skipped[0]?.index).toBe(1);
  });

  it("re-throws MaxNodesExceededError so capacity surfaces (507), never silently skipped", async () => {
    const { ingestor } = newIngestor(1); // the frame anchor consumes the single slot
    await expect(
      ingestor.ingestFacts("f", [{ type: "state", val: "over capacity" }], tok),
    ).rejects.toBeInstanceOf(MaxNodesExceededError);
  });
});
